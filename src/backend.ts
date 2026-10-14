// @ts-nocheck
import { randomHex } from "./lib/id.ts";
import { pump } from "./lib/http.ts";
import { OC_BIN, OC_SERVER, OC_USERNAME, OC_PASSWORD, OC_WORKDIR, REQUEST_TIMEOUT } from "./config.ts";

let ocBase: string | null = null;
let ocAuth: string | null = null;

export function ocBaseValue() { return ocBase; }
export function ocAuthValue() { return ocAuth; }

function basicAuth(user: string, password: string) {
  // RFC 7617 basic auth is UTF-8, which btoa() only handles byte by byte.
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return "Basic " + btoa(String.fromCharCode(...bytes));
}

export async function ocReq(method: string, pathname: string, body?: any) {
  const data = body !== undefined ? JSON.stringify(body) : null;
  try {
    const res = await fetch((ocBase as string) + pathname, {
      method,
      headers: {
        ...(ocAuth ? { Authorization: ocAuth } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { status: res.status, json, raw };
  } catch (e: any) {
    throw new Error(
      e?.name === "TimeoutError"
        ? "opencode request timed out"
        : `opencode request failed: ${e?.message || e}`
    );
  }
}

async function mkdirp(dir: string) {
  const mkdir = Bun.spawn(["mkdir", "-p", dir], { stdout: "ignore", stderr: "ignore" });
  const code = await mkdir.exited;
  if (code !== 0) throw new Error(`could not create OC_WORKDIR: ${dir}`);
}

export async function startBackend() {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD ? basicAuth(OC_USERNAME, OC_PASSWORD) : null;
    return;
  }
  if (OC_BIN === "opencode" && !Bun.which("opencode")) {
    throw new Error("opencode binary not found - set OC_BIN or install opencode");
  }
  await mkdirp(OC_WORKDIR);
  const password = "oc-" + randomHex(12);
  const child = Bun.spawn([OC_BIN, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.exited.then((code: any) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (chunk: string) => {
      buf += chunk;
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    // Both pipes stay drained for the lifetime of the child, otherwise it blocks
    // once the pipe buffer fills.
    pump(child.stdout, onData);
    pump(child.stderr, onData);
    child.exited.then((code: any) => { clearTimeout(timer); reject(new Error(`opencode serve exited early (code ${code})`)); });
  });
  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = basicAuth("opencode", password);
  console.log(`[OC] opencode serve backend on ${ocBase}`);

  for (let i = 0; i < 60; i++) {
    try {
      const r: any = await ocReq("GET", "/api/model");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("opencode serve did not become healthy");
}