import type { Context } from "hono";

// An empty body is an empty object; anything else has to be valid JSON, and a
// parse error is left to bubble up into Hono's error handler.
export async function jsonBody(c: Context): Promise<any> {
  const raw = await c.req.text();
  return raw ? JSON.parse(raw) : {};
}

// Reads a byte stream (a fetch response body, a child process pipe) to the end and
// hands each decoded chunk to `onText`. Never throws: callers stop reading by
// closing the underlying stream.
export async function pump(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<void> {
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