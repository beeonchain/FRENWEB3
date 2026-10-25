// Runs after payment, once the server is up: SSH in with the order's one-time
// key, install Fren in web-setup mode, and save the setup link. The installer
// removes that key from the server when it's done, and the wizard forgets it.
import { installUrl, sshRun, wizard } from "./lib/runtime.mjs";

export default async (req) => {
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return;
  await wizard().install(id, sshRun, installUrl());
};
