import { handle, json, wizard } from "./lib/runtime.mjs";

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only." });
  const body = await req.json().catch(() => ({}));
  return handle(() => wizard().code(body.id, body.code));
};

export const config = { path: "/api/vps/code" };
