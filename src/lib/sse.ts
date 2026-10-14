import type { ServerResponse } from "http";

export function writeSafe(res: ServerResponse | any, s: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try { return res.write(s); } catch { return false; }
}

export function sseHead(res: ServerResponse | any): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}