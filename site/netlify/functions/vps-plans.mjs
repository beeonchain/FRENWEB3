import { handle, wizard } from "./lib/runtime.mjs";

export default async () => handle(async () => ({ plans: await wizard().plans() }));

export const config = { path: "/api/vps/plans" };
