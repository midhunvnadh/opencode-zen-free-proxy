// @ts-nocheck
import { ocBaseValue, ocAuthValue } from "./backend.ts";
import { pump } from "./lib/http.ts";

// Tails opencode's event stream and pushes the text deltas of the session this
// request is talking about into the sink. Closing is idempotent: the caller holds
// the returned handle and closes it when the relay is done or the client left.
export function connectEvents(watch: any) {
  let closed = false;
  const abort = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
  };
  (async () => {
    try {
      const ocAuth = ocAuthValue();
      const res = await fetch((ocBaseValue() as string) + "/api/event", {
        headers: { ...(ocAuth ? { Authorization: ocAuth } : {}) },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) return;
      let buf = "";
      await pump(res.body, (text) => {
        buf += text;
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          onFrame(watch, buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
    } catch {}
    close();
  })();
  return { close };
}

function onFrame(watch: any, frame: string) {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return;
  let ev: any;
  try { ev = JSON.parse(line.slice(5)); } catch { return; }
  const data = ev.data || ev.properties || {};
  if (!watch.sid || data.sessionID !== watch.sid) return;
  if (ev.type === "session.reasoning.delta" && typeof data.delta === "string" && data.delta) {
    watch.sink.delta("reasoning", data.delta);
  } else if (ev.type === "session.text.delta" && typeof data.delta === "string" && data.delta) {
    watch.sink.delta("text", data.delta);
  }
}