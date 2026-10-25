// Wires the wizard to Netlify: Blobs for state, ssh2 for the one-time install.
import { getStore } from "@netlify/blobs";
import ssh2 from "ssh2";
import { eqvpsClient } from "./eqvps.mjs";
import { createWizard, KEY_TAG, UserError } from "./wizard.mjs";

const siteUrl = () => process.env.URL ?? "https://getfren.netlify.app";

export function wizard() {
  const blobs = getStore({ name: "fren-vps", consistency: "strong" });
  return createWizard({
    eqvps: eqvpsClient(process.env.EQVPS_API ? { base: process.env.EQVPS_API } : {}),
    store: {
      get: (id) => blobs.get(id, { type: "json" }),
      set: (id, v) => blobs.setJSON(id, v),
    },
    keygen: () => {
      const k = ssh2.utils.generateKeyPairSync("ed25519", { comment: KEY_TAG });
      return { publicKey: k.public, privateKey: k.private };
    },
    triggerInstall: async (id) => {
      // Background functions answer 202 at once and run for up to 15 minutes.
      const res = await fetch(`${siteUrl()}/.netlify/functions/vps-install-background`, { method: "POST", body: JSON.stringify({ id }) });
      if (res.status >= 400) throw new Error(`Couldn't start the install (${res.status}).`);
    },
  });
}

export const installUrl = () => process.env.FREN_INSTALL_URL ?? `${siteUrl()}/install.sh`;

/** Run one command over SSH, retrying the connection while the server boots. */
export async function sshRun({ host, port, privateKey, command, onLine }, { tries = 30, waitMs = 10_000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await sshOnce({ host, port, privateKey, command, onLine });
    } catch (err) {
      if (err.started) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function sshOnce({ host, port, privateKey, command, onLine }) {
  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client();
    let output = "";
    let partial = "";
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return reject(Object.assign(err, { started: true }));
          const take = (d) => {
            const text = d.toString();
            output = (output + text).slice(-100_000);
            const lines = (partial + text).split("\n");
            partial = lines.pop() ?? "";
            for (const l of lines) onLine?.(l);
          };
          stream.on("data", take);
          stream.stderr.on("data", take);
          stream.on("close", (code) => {
            conn.end();
            resolve({ code: code ?? 1, output });
          });
        });
      })
      .on("error", reject)
      .connect({ host, port, username: "root", privateKey, readyTimeout: 20_000, keepaliveInterval: 15_000 });
  });
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Turns thrown errors into { error } with a status the page can show. */
export async function handle(fn) {
  try {
    return json(200, await fn());
  } catch (err) {
    if (err instanceof UserError) return json(400, { error: err.message });
    console.error(err);
    return json(502, { error: "The VPS provider didn't answer as expected. Try again in a minute." });
  }
}
