export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function getJson<T>(fetchFn: Fetch, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchFn(url, { headers: { accept: "application/json", ...headers } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`GET ${url} → ${res.status}`, res.status, text);
  return JSON.parse(text) as T;
}

export async function postJson<T>(fetchFn: Fetch, url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`POST ${url} → ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  return JSON.parse(text) as T;
}
