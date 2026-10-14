import { OC_BIN, OC_PASSWORD, OC_SERVER, OC_USERNAME, OC_WORKDIR, REQUEST_TIMEOUT } from "./config.ts";
import { HttpError, basicAuth, pump, randomHex, sleep } from "./lib.ts";

/** Everything the proxy needs to talk to one `opencode serve` backend: spawning or
 *  reusing it, the request plumbing, the model list, the conversations and the event
 *  tail that feeds streaming responses. */

type Watch = { sid: string | null; sink: { delta(kind: string, text: string): void } };

let base = "";
let auth: string | null = null;

export const ocBase = () => base;

/** The backend answered with an error: keep its status when the client caused it,
 *  report everything else as a bad gateway. */
function upstreamError(r: { status: number; json: any }) {
  const message = r.json?.data?.message || r.json?.error?.message || r.json?.message || `opencode server returned ${r.status}`;
  return new HttpError([400, 401, 429].includes(r.status) ? r.status : 502, message);
}

export async function request(method: string, pathname: string, body?: unknown) {
  const data = body === undefined ? null : JSON.stringify(body);
  try {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(auth ? { Authorization: auth } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
      body: data,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { status: res.status, json };
  } catch (e: any) {
    throw new HttpError(502, e?.name === "TimeoutError" ? "opencode request timed out" : `opencode request failed: ${e?.message || e}`);
  }
}

let models: string[] | null = null;

export async function listModels(): Promise<string[]> {
  if (models) return models;
  const r = await request("GET", "/api/model");
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new HttpError(502, "failed to list opencode models");
  const found: string[] = r.json.data
    .filter((m: any) => m.providerID === "opencode")
    .map((m: any) => m.id || m.modelID)
    .filter(Boolean);
  if (!found.length) throw new HttpError(502, "no opencode models found");
  return (models = found);
}

export const modelCount = () => (models ? models.length : 0);

// A conversation is a session plus the turns already spent on it. Turns are chained
// because opencode answers one session in order.
type Session = { sessionID: string | null; turns: number; chain: Promise<unknown> };

const sessions = new Map<string, Session>();

function session(key: string) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, turns: 0, chain: Promise.resolve() });
  return sessions.get(key) as Session;
}

async function createSession(modelId: string) {
  const r = await request("POST", "/api/session", { title: "proxy", agent: "build", model: { id: modelId, providerID: "opencode" } });
  if (r.status !== 200) throw upstreamError(r);
  const sid = r.json?.data?.id;
  if (!sid) throw new HttpError(502, "opencode did not return a session id");
  return sid;
}

/** Prompts a session and returns the assistant message it answered with. */
async function runPrompt(sid: string, text: string, system: string) {
  const pr = await request("POST", `/api/session/${sid}/prompt`, { text: system ? `System: ${system}\\n\\n${text}` : text });
  if (pr.status !== 200 && pr.status !== 202) throw upstreamError(pr);
  const wait = await request("POST", `/api/experimental/session/${sid}/wait`);
  if (wait.status !== 204 && wait.status !== 200) throw upstreamError(wait);
  const r = await request("GET", `/api/session/${sid}/message`);
  if (r.status !== 200) throw upstreamError(r);
  const replies = (Array.isArray(r.json?.data) ? r.json.data : []).filter((m: any) => m?.type === "assistant");
  if (!replies.length) throw new HttpError(502, "no assistant reply from opencode");
  return replies.reduce((a: any, b: any) => ((a?.time?.created || 0) < (b?.time?.created || 0) ? b : a));
}

/** Runs one turn. Without a session key the conversation is stateless and torn down
 *  again; with one the session is kept, so the first turn replays the transcript the
 *  client sent and every later turn continues it. */
export async function askModel(req: {
  key: string | null;
  modelId: string;
  system: string;
  transcript: string;
  lastUserText: string;
  onSession?: (sid: string) => void;
}) {
  const { key, modelId, system, transcript, lastUserText, onSession } = req;
  if (!key) {
    const sid = await createSession(modelId);
    onSession?.(sid);
    try {
      return await runPrompt(sid, transcript || lastUserText, system);
    } finally {
      request("DELETE", `/api/session/${sid}`).catch((e: any) => console.log(`[OC] temp session ${sid} not deleted:`, e.message));
    }
  }
  const entry = session(key);
  const run = entry.chain.then(async () => {
    const fresh = !entry.sessionID;
    const sid = (entry.sessionID ??= await createSession(modelId));
    if (fresh) entry.turns = 0;
    onSession?.(sid);
    const base = entry.turns === 0 ? transcript || lastUserText : lastUserText;
    entry.turns += 1;
    return runPrompt(sid, base, system);
  });
  entry.chain = run.catch(() => {});
  return run;
}

/** Tails the backend's event stream and pushes this request's deltas into the sink.
 *  Closing is idempotent: the caller holds the handle and closes it once the reply is
 *  done or the client left. */
export function connectEvents(watch: Watch) {
  const abort = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
  };
  (async () => {
    try {
      const res = await fetch(base + "/api/event", { headers: auth ? { Authorization: auth } : {}, signal: abort.signal });
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

function onFrame(watch: Watch, frame: string) {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return;
  let ev: any;
  try { ev = JSON.parse(line.slice(5)); } catch { return; }
  const data = ev.data || ev.properties || {};
  if (!watch.sid || data.sessionID !== watch.sid || typeof data.delta !== "string" || !data.delta) return;
  if (ev.type === "session.reasoning.delta") watch.sink.delta("reasoning", data.delta);
  else if (ev.type === "session.text.delta") watch.sink.delta("text", data.delta);
}

/** Brings the backend up: reuses OC_SERVER when one is configured, otherwise spawns
 *  `opencode serve` and waits until it answers. */
export async function start() {
  if (OC_SERVER) {
    base = OC_SERVER.replace(/\/$/, "");
    auth = OC_PASSWORD ? basicAuth(OC_USERNAME, OC_PASSWORD) : null;
    return;
  }
  if (OC_BIN === "opencode" && !Bun.which("opencode")) throw new Error("opencode binary not found - set OC_BIN or install opencode");
  const mkdir = Bun.spawn(["mkdir", "-p", OC_WORKDIR], { stdout: "ignore", stderr: "ignore" });
  if ((await mkdir.exited) !== 0) throw new Error(`could not create OC_WORKDIR: ${OC_WORKDIR}`);

  const password = "oc-" + randomHex(12);
  const child = Bun.spawn([OC_BIN, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.exited.then((code) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

  // Both pipes stay drained for the lifetime of the child, otherwise it blocks once
  // the pipe buffer fills.
  const port = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (chunk: string) => {
      buf += chunk;
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    pump(child.stdout, onData);
    pump(child.stderr, onData);
    child.exited.then((code) => { clearTimeout(timer); reject(new Error(`opencode serve exited early (code ${code})`)); });
  });
  base = `http://127.0.0.1:${port}`;
  auth = basicAuth("opencode", password);
  console.log(`[OC] opencode serve backend on ${base}`);

  for (let i = 0; i < 60; i++) {
    try {
      if ((await request("GET", "/api/model")).status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("opencode serve did not become healthy");
}
