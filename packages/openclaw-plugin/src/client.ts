import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EngineClientOptions {
  apiUrl?: string;
  tokenFile?: string;
  fetchFn?: typeof fetch;
}

/** Thin HTTP client for the local Jarvis engine. Holds a token, never a key. */
export class EngineClient {
  readonly apiUrl: string;
  private readonly tokenFile: string;
  private readonly fetchFn: typeof fetch;

  constructor(o: EngineClientOptions = {}) {
    this.apiUrl = (o.apiUrl ?? "http://127.0.0.1:7420").replace(/\/$/, "");
    this.tokenFile = o.tokenFile ?? join(process.env.JARVIS_HOME ?? join(homedir(), ".jarvis"), "api-token");
    this.fetchFn = o.fetchFn ?? fetch;
  }

  private token(): string {
    try {
      return readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      throw new Error(`Jarvis engine token not found at ${this.tokenFile}. Run \`jarvis init\` and \`jarvis start\`.`);
    }
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Can't reach the Jarvis engine at ${this.apiUrl}. Is \`jarvis start\` running?`);
    }
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Jarvis engine returned ${res.status}`);
    return json;
  }
}

export interface OwnerResult {
  text: string;
  verdict?: string;
  codeSentPrivately?: boolean;
  ownerCode?: string;
}
