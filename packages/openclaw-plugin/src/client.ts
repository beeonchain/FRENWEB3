import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EngineClientOptions {
  apiUrl?: string;
  tokenFile?: string;
  fetchFn?: typeof fetch;
}

/** Thin HTTP client for the local Fren engine. Holds a token, never a key. */
export class EngineClient {
  readonly apiUrl: string;
  private readonly tokenFile: string;
  private readonly fetchFn: typeof fetch;

  constructor(o: EngineClientOptions = {}) {
    this.apiUrl = (o.apiUrl ?? "http://127.0.0.1:7420").replace(/\/$/, "");
    this.tokenFile = o.tokenFile ?? join(process.env.FREN_HOME ?? join(homedir(), ".fren"), "api-token");
    this.fetchFn = o.fetchFn ?? fetch;
  }

  private token(): string {
    try {
      return readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      throw new Error(`Fren engine token not found at ${this.tokenFile}. Run \`fren init\` and \`fren start\`.`);
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
      throw new Error(`Can't reach the Fren engine at ${this.apiUrl}. Is \`fren start\` running?`);
    }
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Fren engine returned ${res.status}`);
    return json;
  }
}

export interface OwnerResult {
  text: string;
  verdict?: string;
  codeSentPrivately?: boolean;
  ownerCode?: string;
}
