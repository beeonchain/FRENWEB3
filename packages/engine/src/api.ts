import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describeLimits, type Jarvis } from "./engine.js";

/**
 * Local HTTP API for the OpenClaw plugin. Bound to 127.0.0.1 and gated by a
 * bearer token. It exposes only what the plugin's tools and commands need;
 * there is no route that returns key material.
 */
export function createApi(jarvis: Jarvis, token: string): Server {
  const expected = Buffer.from(token);

  const authed = (req: IncomingMessage) => {
    const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true }),
    "GET /wallet": async () => jarvis.wallet(),
    "GET /status": async () => ({ text: await jarvis.status() }),
    "GET /markets": async (_b, url) => ({ text: await jarvis.searchMarkets(url.searchParams.get("q") ?? "") }),
    "GET /limits": async () => ({ limits: jarvis.limits(), text: describeLimits(jarvis.limits()) }),
    "GET /events": async (_b, url) => ({ events: jarvis.recentEvents(Number(url.searchParams.get("since") ?? 0)) }),
    "POST /plans": async (b) => jarvis.submit(b.plan),
    "POST /approve": async (b) => ({ text: await jarvis.approve(String(b.code ?? "")) }),
    "POST /limits": async (b) => jarvis.changeLimits(String(b.args ?? "")),
    "POST /resume": async () => jarvis.requestResume(),
    "POST /stop": async (b) => ({ text: await jarvis.stop(Boolean(b.flatten)) }),
    "POST /cancel": async (b) => ({ text: await jarvis.cancel(String(b.planId ?? "")) }),
    "POST /deposit/hyperliquid": async (b) => ({ text: await jarvis.depositToHyperliquid(Number(b.amountUsd)) }),
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!authed(req)) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: "not found" });
    try {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 256 * 1024) return send(413, { error: "too large" });
          chunks.push(c as Buffer);
        }
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      }
      send(200, await handler(body, url));
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
}
