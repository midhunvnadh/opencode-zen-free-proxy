/** A failure that already carries the status and type the client should see. */
export class HttpError extends Error {
  status: number;
  type: string;
  constructor(status: number, message: string, type = "upstream_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/** Normalizes anything thrown into an HttpError. `fallback` covers the failures that
 *  carry no status of their own: network, timeout, programming errors. */
export function describeError(e: unknown, fallback = 502) {
  const err = e instanceof HttpError ? e : new HttpError(fallback, e instanceof Error ? e.message : String(e));
  return { status: err.status, type: err.type, message: err.message };
}

export function randomHex(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const rid = (prefix: string, bytes = 12) => prefix + randomHex(bytes);
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RFC 7617 basic auth is UTF-8, which btoa() only handles byte by byte. */
export function basicAuth(user: string, password: string) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return "Basic " + btoa(String.fromCharCode(...bytes));
}

/** Reads a byte stream (a fetch response body, a child process pipe) to the end and
 *  hands each decoded chunk to `onText`. Never throws: callers stop reading by
 *  closing the underlying stream. */
export async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
    onText(decoder.decode());
  } catch {}
}

/** Bun has no synchronous stat, so the backend binary is resolved once here while the
 *  process starts up; everything after the config import sees a real path. */
export async function findBinary(): Promise<string> {
  if (typeof Bun === "undefined") return "opencode";
  const home = process.env.HOME || "";
  const candidates = [
    home && `${home}/.opencode/bin/opencode`,
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ].filter(Boolean);
  for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
  return Bun.which("opencode") || "opencode";
}
