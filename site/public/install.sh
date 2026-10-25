#!/usr/bin/env bash
# Fren installer: OpenClaw, Node, Fren, then the guided `fren setup`.
#
#   curl -fsSL https://getfren.netlify.app/install.sh | bash
#
# On a fresh VPS (as root), --server also creates a `fren` user and runs the
# engine and the OpenClaw gateway as system services that survive reboots:
#
#   curl -fsSL https://getfren.netlify.app/install.sh | bash -s -- --server
#
# Options:
#   --server       VPS mode (see above). Needs root and systemd.
#   --no-setup     Install only; run `fren setup` yourself later.
#   --ref REF      Branch or tag to install (default: main). Env: FREN_REF
#   --repo URL     Git repository (default: GitHub). Env: FREN_REPO
#   --dir DIR      Where the code goes (default: ~/.fren-app). Env: FREN_APP_DIR
#   --web          With --server: serve the setup as a private HTTPS page
#                  (https://<ip>.sslip.io/setup) instead of asking questions
#                  here, and print its one-time link as FREN_SETUP_URL=...
#   --drop-key TAG With --server: when done, remove root's SSH keys whose
#                  comment is TAG (the VPS wizard's one-time key).
set -euo pipefail

# Everything lives in main() so bash reads the whole script before running any
# of it: nothing below can swallow the rest of a piped `curl | bash`.
main() {
FREN_REPO="${FREN_REPO:-https://github.com/beeonchain/frenweb3.git}"
FREN_REF="${FREN_REF:-main}"
FREN_APP_DIR="${FREN_APP_DIR:-}"
SERVER=0
SETUP=1
WEB=0
DROP_KEY=""
NODE_MIN="24.16.0"
OPENCLAW_MIN="2026.10.5"
SERVICE_USER="fren"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER=1 ;;
    --no-setup) SETUP=0 ;;
    --web) WEB=1 ;;
    --drop-key) DROP_KEY="${2:?--drop-key needs a value}"; shift ;;
    --ref) FREN_REF="${2:?--ref needs a value}"; shift ;;
    --repo) FREN_REPO="${2:?--repo needs a value}"; shift ;;
    --dir) FREN_APP_DIR="${2:?--dir needs a value}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# version_ge A B: true when A >= B (dotted numbers).
version_ge() {
  local -a a b
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    ((10#$x > 10#$y)) && return 0
    ((10#$x < 10#$y)) && return 1
  done
  return 0
}

have() { command -v "$1" >/dev/null 2>&1; }

# A terminal to ask questions on, even when this script arrives through a pipe.
has_tty() { [[ -t 0 ]] || { [[ -r /dev/tty ]] && (exec </dev/tty) 2>/dev/null; }; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) die "Fren runs on macOS and Linux. On Windows, install WSL (wsl --install) and run this inside it." ;;
esac

bold ""
bold "  Fren: your on-chain trading agent, on your own machine"
bold ""

[[ $WEB -eq 1 && $SERVER -eq 0 ]] && die "--web goes with --server."
if [[ $SERVER -eq 1 ]]; then
  [[ $OS == linux ]] || die "--server is for a Linux VPS."
  [[ $EUID -eq 0 ]] || die "--server needs root (run it as root on the VPS)."
  have systemctl || die "--server needs systemd."
  SUDO=""
else
  if [[ $EUID -eq 0 ]]; then
    warn "You're root. On a VPS use --server so Fren runs as its own user."
  fi
  SUDO=""
  [[ $EUID -ne 0 ]] && have sudo && SUDO="sudo"
fi

# --- System packages ---------------------------------------------------------

pkg_install() {
  if have apt-get; then
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif have dnf; then
    $SUDO dnf install -y -q "$@" >/dev/null
  elif have yum; then
    $SUDO yum install -y -q "$@" >/dev/null
  elif have apk; then
    $SUDO apk add --no-cache "$@" >/dev/null
  elif have pacman; then
    $SUDO pacman -Sy --noconfirm --needed "$@" >/dev/null
  else
    return 1
  fi
}

step "Checking the basics"
missing=()
for t in git curl; do have "$t" || missing+=("$t"); done
if [[ $OS == linux ]] && ! have make; then
  # A few dependencies compile small native helpers.
  if have apt-get; then missing+=(build-essential); elif have apk; then missing+=(build-base); else missing+=(make gcc gcc-c++); fi
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  if [[ $OS == macos ]]; then
    have git || die "Install the Xcode command line tools first: xcode-select --install"
  else
    echo "Installing ${missing[*]}…"
    pkg_install "${missing[@]}" ca-certificates || die "Couldn't install ${missing[*]}. Install them and run this again."
  fi
fi
echo "✓ git, curl"

if [[ $SERVER -eq 1 ]]; then
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$SERVICE_USER"
    echo "✓ Created user $SERVICE_USER"
  fi
  SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  chmod 750 "$SERVICE_HOME"
  # Small VPSes run out of memory building Fren; a swap file fixes that.
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  if [[ "$mem_kb" -lt 3000000 ]] && ! swapon --show 2>/dev/null | grep -q .; then
    if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; then
      chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >>/etc/fstab
      echo "✓ Added 2 GB of swap"
    fi
  fi
fi

# Run a command as the user Fren belongs to.
as_fren() {
  if [[ $SERVER -eq 1 ]]; then
    runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$PATH" "$@"
  else
    "$@"
  fi
}

# --- Node and OpenClaw -------------------------------------------------------

add_node_paths() {
  # Wherever OpenClaw's installer may have put node and openclaw.
  local p
  for p in "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin /opt/homebrew/bin; do
    [[ -d "$p" && ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
  done
  if have npm; then
    p="$(npm prefix -g 2>/dev/null)/bin"
    [[ -d "$p" && ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
  fi
  export PATH
}

node_ok() { have node && version_ge "$(node -p 'process.versions.node' 2>/dev/null || echo 0)" "$NODE_MIN"; }

# An older node earlier on PATH can hide the one OpenClaw just installed: put the
# first new-enough node in front.
pick_node() {
  local n v
  for n in $(type -ap node 2>/dev/null) /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "$n" ]] || continue
    v="$("$n" -p 'process.versions.node' 2>/dev/null)" || continue
    if version_ge "$v" "$NODE_MIN"; then
      PATH="$(dirname "$n"):$PATH"
      export PATH
      hash -r
      return 0
    fi
  done
  return 1
}
openclaw_ok() {
  have openclaw || return 1
  local v
  v="$(openclaw --version 2>/dev/null | grep -Eo '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)"
  [[ -n "$v" ]] && version_ge "$v" "$OPENCLAW_MIN"
}

step "Node and OpenClaw"
add_node_paths
pick_node || true
if ! node_ok || ! openclaw_ok; then
  echo "Installing OpenClaw (and Node $NODE_MIN+ if needed) with OpenClaw's own installer…"
  # Locally it may ask before touching an existing nvm; on a server it just installs.
  oc_flags=(--no-onboard)
  if [[ $SERVER -eq 1 ]] || ! has_tty; then oc_flags+=(--no-prompt); fi
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- "${oc_flags[@]}"
  add_node_paths
  pick_node || true
fi
node_ok || die "Fren needs Node $NODE_MIN or newer, and the OpenClaw installer didn't leave one on PATH. Install Node 24 (https://nodejs.org) and run this again."
openclaw_ok || die "OpenClaw $OPENCLAW_MIN or newer isn't on PATH. Install it with: curl -fsSL https://openclaw.ai/install.sh | bash"
echo "✓ Node $(node -p 'process.versions.node'), $(openclaw --version 2>/dev/null | head -1)"

# --- Fren --------------------------------------------------------------------

if [[ -z "$FREN_APP_DIR" ]]; then
  if [[ $SERVER -eq 1 ]]; then FREN_APP_DIR="$SERVICE_HOME/.fren-app"; else FREN_APP_DIR="$HOME/.fren-app"; fi
fi

step "Downloading Fren ($FREN_REF)"
if [[ -d "$FREN_APP_DIR/.git" ]]; then
  as_fren git -C "$FREN_APP_DIR" fetch --quiet --depth 1 origin "$FREN_REF"
  as_fren git -C "$FREN_APP_DIR" checkout --quiet --force FETCH_HEAD
else
  [[ -e "$FREN_APP_DIR" ]] && die "$FREN_APP_DIR exists but isn't a Fren checkout. Move it away or pass --dir."
  [[ $SERVER -eq 1 ]] && install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$(dirname "$FREN_APP_DIR")"
  as_fren git clone --quiet --depth 1 --branch "$FREN_REF" "$FREN_REPO" "$FREN_APP_DIR" \
    || die "Couldn't download Fren from $FREN_REPO."
fi
echo "✓ $(as_fren git -C "$FREN_APP_DIR" log -1 --format='%h %s')"

step "Building Fren (a couple of minutes)"
(
  cd "$FREN_APP_DIR"
  as_fren npm ci --no-audit --no-fund --loglevel=error
  as_fren npm run --silent build
) || die "The build failed. Scroll up for the error, or ask for help with it."
echo "✓ Built"

FREN_CLI="$FREN_APP_DIR/packages/engine/dist/cli.js"
NODE_BIN="$(command -v node)"
OPENCLAW_BIN="$(command -v openclaw)"

# A `fren` command on PATH.
if [[ $SERVER -eq 1 ]]; then
  FREN_BIN=/usr/local/bin/fren
  cat >"$FREN_BIN" <<EOF
#!/bin/sh
# Fren runs as the $SERVICE_USER user; this wrapper switches to it.
if [ "\$(id -u)" = 0 ]; then
  exec runuser -u $SERVICE_USER -- env HOME=$SERVICE_HOME PATH="$PATH" "$NODE_BIN" "$FREN_CLI" "\$@"
fi
exec "$NODE_BIN" "$FREN_CLI" "\$@"
EOF
  chmod 755 "$FREN_BIN"
else
  mkdir -p "$HOME/.local/bin"
  FREN_BIN="$HOME/.local/bin/fren"
  cat >"$FREN_BIN" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$FREN_CLI" "\$@"
EOF
  chmod 755 "$FREN_BIN"
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [[ -f "$rc" ]] && ! grep -q '.local/bin' "$rc" && printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
    done
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
echo "✓ fren command: $FREN_BIN"

# --- Services on a VPS -------------------------------------------------------

write_server_units() {
  local path_env
  path_env="$(dirname "$NODE_BIN"):$(dirname "$OPENCLAW_BIN"):/usr/local/bin:/usr/bin:/bin"
  cat >/etc/systemd/system/fren.service <<EOF
[Unit]
Description=Fren engine (policy, signer, watcher)
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=PATH=$path_env
ExecStart=$NODE_BIN $FREN_CLI start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/fren-openclaw.service <<EOF
[Unit]
Description=OpenClaw gateway for Fren
After=network-online.target fren.service
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=PATH=$path_env
ExecStart=$OPENCLAW_BIN gateway run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

# --- Setup in the browser (VPS wizard) ---------------------------------------

# Caddy gets a real HTTPS certificate for <ip>.sslip.io, a free hostname that
# points at this server, and forwards to Fren's setup page on localhost. When the
# owner presses "Start Fren", a path unit starts Fren and the gateway and shuts
# the setup page and Caddy down for good.
web_setup() {
  local ip host token caddy_bin arch url code="" done_file=$SERVICE_HOME/.fren-setup-done
  ip="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me)" \
    || die "Couldn't find this server's public IPv4 address."
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Odd public IP: $ip"
  host="${ip//./-}.sslip.io"
  token="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"

  step "HTTPS for the setup page ($host)"
  caddy_bin=/usr/local/bin/caddy
  if [[ ! -x $caddy_bin ]]; then
    case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "No Caddy build for $(uname -m)." ;; esac
    curl -fsSL --max-time 180 -o "$caddy_bin" "https://caddyserver.com/api/download?os=linux&arch=$arch" || die "Couldn't download Caddy."
    chmod 755 "$caddy_bin"
  fi
  install -d -m 700 /etc/fren
  printf '{\n\tadmin off\n}\n%s {\n\treverse_proxy 127.0.0.1:7421\n}\n' "$host" >/etc/fren/Caddyfile
  printf 'FREN_SETUP_TOKEN=%s\n' "$token" >/etc/fren/setup.env
  chmod 600 /etc/fren/setup.env
  rm -f "$done_file"

  cat >/etc/systemd/system/fren-setup-caddy.service <<UNIT
[Unit]
Description=HTTPS for the Fren setup page
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=/var/lib/fren-caddy
ExecStartPre=/usr/bin/mkdir -p /var/lib/fren-caddy
ExecStart=$caddy_bin run --config /etc/fren/Caddyfile --adapter caddyfile
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
  cat >/etc/systemd/system/fren-setup.service <<UNIT
[Unit]
Description=Fren setup page (closes after setup)
After=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=PATH=$(dirname "$NODE_BIN"):$(dirname "$OPENCLAW_BIN"):/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/fren/setup.env
ExecStart=$NODE_BIN $FREN_CLI setup --web --port 7421 --done-file $done_file
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
  cat >/etc/systemd/system/fren-setup-done.path <<UNIT
[Unit]
Description=Start Fren when web setup finishes

[Path]
PathExists=$done_file
Unit=fren-setup-finish.service

[Install]
WantedBy=multi-user.target
UNIT
  cat >/etc/systemd/system/fren-setup-finish.service <<UNIT
[Unit]
Description=Start Fren and close the setup page

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'sleep 3; systemctl disable --now fren-setup.service fren-setup-caddy.service fren-setup-done.path; rm -f /etc/fren/setup.env; systemctl enable --now fren.service; systemctl enable fren-openclaw.service; systemctl restart fren-openclaw.service'
UNIT
  write_server_units
  systemctl enable --now fren-setup-done.path fren-setup.service fren-setup-caddy.service >/dev/null 2>&1

  # Wait for the certificate, so the link works the moment it's shown. The page
  # answers 403 to anyone without the token, which means HTTPS is up.
  url="https://$host/setup?t=$token"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$host/setup" || true)"
    [[ "$code" == 403 ]] && break
    sleep 3
  done
  [[ "$code" == 403 ]] || warn "The setup page isn't answering over HTTPS yet (got ${code:-nothing}). It may need another minute."
  bold ""
  bold "Open this link to finish setting up Fren (keep it private):"
  echo "  $url"
  echo "FREN_SETUP_URL=$url"
}

drop_installer_key() {
  [[ -n "$DROP_KEY" && -f /root/.ssh/authorized_keys ]] || return 0
  local kept
  kept="$(grep -v -F -- " $DROP_KEY" /root/.ssh/authorized_keys || true)"
  printf '%s\n' "$kept" >/root/.ssh/authorized_keys
  echo "✓ Removed the installer's SSH key"
}

# --- Guided setup ------------------------------------------------------------

if [[ $SETUP -eq 0 ]]; then
  [[ $SERVER -eq 1 ]] && write_server_units
  drop_installer_key
  bold ""
  bold "Fren is installed. Run \`fren setup\` to connect your AI model, chat app and wallets."
  exit 0
fi

if [[ $WEB -eq 1 ]]; then
  web_setup
  drop_installer_key
  exit 0
fi

has_tty || die "Setup asks a few questions and needs a terminal. Run \`fren setup\` in one."

step "Setup"
if [[ $SERVER -eq 1 ]]; then
  # OpenClaw and Fren don't need to be running while you answer.
  systemctl stop fren-openclaw.service fren.service 2>/dev/null || true
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$PATH" "$NODE_BIN" "$FREN_CLI" setup --server </dev/tty
  write_server_units
  systemctl enable --now fren.service >/dev/null 2>&1
  systemctl enable fren-openclaw.service >/dev/null 2>&1
  systemctl restart fren-openclaw.service
  sleep 3
  systemctl is-active --quiet fren.service || warn "The Fren engine didn't start. See: journalctl -u fren -n 50"
  systemctl is-active --quiet fren-openclaw.service || warn "The OpenClaw gateway didn't start. See: journalctl -u fren-openclaw -n 50"
  drop_installer_key
  bold ""
  bold "✓ Fren and OpenClaw are running on this server and restart on their own."
  echo "  Logs:    journalctl -u fren -f    |    journalctl -u fren-openclaw -f"
  echo "  Status:  fren status"
else
  "$NODE_BIN" "$FREN_CLI" setup </dev/tty
fi
}

main "$@"
