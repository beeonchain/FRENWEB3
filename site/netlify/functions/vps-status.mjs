import { handle, wizard } from "./lib/runtime.mjs";

export default async (req) => handle(() => wizard().status(new URL(req.url).searchParams.get("id")));

export const config = { path: "/api/vps/status" };
