// @ts-nocheck
import fs from "fs";
import http from "http";
import { spawn, execSync } from "child_process";
import { randomHex } from "./lib/id.ts";
import { OC_BIN, OC_SERVER, OC_USERNAME, OC_PASSWORD, OC_WORKDIR, REQUEST_TIMEOUT } from "./config.ts";

let ocBase: string | null = null;
let ocAuth: string | null = null;
let childProcess: any = null;

export function ocBaseValue() { return ocBase; }
export function ocAuthValue() { return ocAuth; }

export function ocReq(method: string, pathname: string, body?: any) {
  return new Promise((resolve, reject) => {
    const u = new URL((ocBase as string) + pathname);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(ocAuth ? { Authorization: ocAuth } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("opencode request timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

export async function startBackend() {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD
      ? "Basic " + Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")
      : null;
    return;
  }
  if (OC_BIN === "opencode") {
    try { execSync("command -v opencode", { stdio: "ignore" }); }
    catch { throw new Error("opencode binary not found - set OC_BIN or install opencode"); }
  }
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  const password = "oc-" + randomHex(12);
  const child = spawn(OC_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcess = child;
  child.on("exit", (code: any) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (d: any) => {
      buf += d.toString();
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c: any) => { clearTimeout(timer); reject(new Error(`opencode serve exited early (code ${c})`)); });
  });
  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
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
