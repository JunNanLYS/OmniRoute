/** Tiny JSON HTTP client for the harness (no CLI deps). */
import net from "node:net";
export interface HttpJsonResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  headers: Headers;
}

export async function httpJson<T = unknown>(
  url: string,
  init: RequestInit & { bearer?: string } = {}
): Promise<HttpJsonResult<T>> {
  const { bearer, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...rest, headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body: body as T, headers: response.headers };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs: number; label: string }
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
    }
    await sleep(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
  }
}

export function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate a free port"));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
