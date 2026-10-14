// @ts-nocheck
import http from "http";
import { ocBaseValue, ocAuthValue } from "./backend.ts";
// REQUEST_TIMEOUT exported? Need check. We'll import from config instead.
import { REQUEST_TIMEOUT as RT } from "./config.ts";

export function connectEvents(watch: any) {
  let req: any = null;
  let done = false;
  let buf = "";
  const close = () => {
    if (done) return;
    done = true;
    try { req?.destroy(); } catch {}
  };
  const onFrame = (frame: string) => {
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
  };
  try {
    const ocBase = ocBaseValue();
    const ocAuth = ocAuthValue();
    const u = new URL((ocBase as string) + "/api/event");
    req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "GET",
        headers: { ...(ocAuth ? { Authorization: ocAuth } : {}) },
        timeout: RT,
      },
      (r: any) => {
        r.setEncoding("utf8");
        r.on("data", (c: string) => {
          buf += c;
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            onFrame(frame);
          }
        });
        r.on("end", close);
        r.on("error", close);
      }
    );
    req.on("error", close);
    req.on("timeout", close);
    req.end();
  } catch {
    close();
  }
  return { close };
}
