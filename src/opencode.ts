import { OC_BIN, OC_PASSWORD, OC_SERVER, OC_USERNAME, OC_WORKDIR, REQUEST_TIMEOUT } from "./config.ts";
import { HttpError, basicAuth, pump, randomHex, rid, sleep } from "./lib.ts";
import { announcedName, extractMessage } from "./protocols.ts";

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

export async function request(method: string, pathname: string, body?: unknown, signal?: AbortSignal) {
  const data = body === undefined ? null : JSON.stringify(body);
  try {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(auth ? { Authorization: auth } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
      body: data,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT), signal]) : AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { status: res.status, json };
  } catch (e: any) {
    if (signal?.aborted) throw e;
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
// because opencode answers one session in order. `intercept` records whether the session
// was opened with tools blocked, which cannot be changed afterwards — a request that
// needs it and lands on a session without it gets a new one.
type Session = { sessionID: string | null; intercept: boolean; turns: number; chain: Promise<unknown> };

const sessions = new Map<string, Session>();

function session(key: string) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, intercept: false, turns: 0, chain: Promise.resolve() });
  return sessions.get(key) as Session;
}

/** How often a running turn checks whether the model is waiting on a permission. */
const POLL_MS = 250;

/** The last assistant message of a session. */
async function latestAssistant(sid: string) {
  const r = await request("GET", `/api/session/${sid}/message`);
  if (r.status !== 200) throw upstreamError(r);
  const replies = (Array.isArray(r.json?.data) ? r.json.data : []).filter((m: any) => m?.type === "assistant");
  if (!replies.length) throw new HttpError(502, "no assistant reply from opencode");
  return replies.reduce((a: any, b: any) => ((a?.time?.created || 0) < (b?.time?.created || 0) ? b : a));
}

async function createSession(modelId: string, intercept: boolean) {
  const r = await request("POST", "/api/session", {
    title: "proxy",
    agent: "build",
    model: { id: modelId, providerID: "opencode" },
    // Tools are the client's to run, so every one of them asks first. That is what puts
    // a stop between the model's request and the execution — see docs/tool-calling.md.
    ...(intercept ? { permissions: [{ action: "*", resource: "*", effect: "ask" }] } : {}),
  });
  if (r.status !== 200) throw upstreamError(r);
  const sid = r.json?.data?.id;
  if (!sid) throw new HttpError(502, "opencode did not return a session id");
  return sid;
}

/** Waits for a turn to finish, or for the model to ask for a tool. A tool under an `ask`
 *  rule never ends the turn on its own, so the two are waited for together and the first
 *  one to arrive wins. Only a session whose tools are blocked can produce a request, so
 *  `poll` says whether the watch is worth opening. Resolves with the pending request, or
 *  null when the turn ended by itself. */
async function awaitTurn(sid: string, poll: boolean) {
  let done = false;
  let wake = () => {};
  const settled = new Promise<void>((r) => (wake = r));
  const watching = poll
    ? (async () => {
        while (!done) {
          const r = await request("GET", `/api/session/${sid}/permission`);
          const pending = (Array.isArray(r.json?.data) ? r.json.data : []).find((p: any) => p?.source?.type === "tool");
          if (pending) return pending;
          await Promise.race([sleep(POLL_MS), settled]);
        }
        return null;
      })()
    : new Promise<null>(() => {});
  const turn = (async () => {
    const wait = await request("POST", `/api/experimental/session/${sid}/wait`);
    if (wait.status !== 204 && wait.status !== 200) throw upstreamError(wait);
    done = true;
    wake();
    return null;
  })();
  return Promise.race([turn, watching]);
}

/** Says no, which aborts the tool where it stands — nothing has run yet. */
async function reject(sid: string, id: string) {
  const r = await request("POST", `/api/session/${sid}/permission/${id}/reply`, { decision: "reject" });
  if (r.status !== 200 && r.status !== 204) throw upstreamError(r);
}

/** How often a model may reach for a tool of its own before the turn is given up on.
 *  Each refusal costs a round trip, and a model that keeps reaching has already said it
 *  cannot answer without one. */
const MAX_TOOL_ROUNDS = 2;

/** Points the model at what it can call instead, in the same words it was given the tools
 *  in. A model that reached for something it does not have tends to answer that it cannot
 *  do the job at all, and naming the alternative is what keeps it going. */
const pointElsewhere = (name: string, names: string[]) =>
  `The \`${name}\` tool is not available in this environment. To do that, call one of the caller's functions — ${names.join(", ")} — with the tool_call block described above. If none of them will do, answer without it.`;

/** Prompts a session and returns the assistant message it ended with. Reaching for
 *  something the caller does not have costs a round and is pointed elsewhere, whether it
 *  was opencode's own tool or a caller's function the client never declared — see
 *  docs/tool-calling.md. */
async function runPrompt(sid: string, text: string, system: string, names: string[]) {
  const intercept = names.length > 0;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const pr = await request("POST", `/api/session/${sid}/prompt`, { text: system ? `System: ${system}\n\n${text}` : text });
    if (pr.status !== 200 && pr.status !== 202) throw upstreamError(pr);
    const asked = await awaitTurn(sid, intercept);
    if (asked) {
      await reject(sid, asked.id);
      text = pointElsewhere(asked.action, names);
      continue;
    }
    const message = await latestAssistant(sid);
    // A function the client never declared is not its to run, so the block naming it is
    // not handed over. The model is told so and answers properly, rather than the
    // caller's machine being handed a call it never offered.
    const name = intercept ? announcedName(extractMessage(message).text) : null;
    if (!name || names.includes(name)) return message;
    text = pointElsewhere(name, names);
  }
  throw new HttpError(502, "the model kept reaching for tools it does not have");
}

/** Runs one turn. Without a session key the conversation is stateless and torn down
 *  again; with one the session is kept, so the first turn replays the transcript the
 *  client sent and every later turn continues it. `toolResults` is what the client ran,
 *  already written as prompt text, and `directives` is how to call it — both are the
 *  proxy's own words, kept apart from the client's own system prompt. A request that
 *  offers tools runs against a session where opencode's own tools are blocked, which is
 *  what `toolNames` says here. */
export async function askModel(req: {
  key: string | null;
  modelId: string;
  system: string;
  transcript: string;
  lastUserText: string;
  directives?: string;
  toolNames?: string[];
  toolResults?: string;
  onSession?: (sid: string) => void;
}) {
  const { key, modelId, system, transcript, lastUserText, onSession } = req;
  const names = req.toolNames ?? [];
  const intercept = names.length > 0;
  // The request, then what the caller ran in answer to it, then how to call it. The
  // directives go last because a model follows what it reads most recently.
  const prompt = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");

  if (!key) {
    const sid = await createSession(modelId, intercept);
    onSession?.(sid);
    try {
      return await runPrompt(sid, prompt(transcript || lastUserText, req.toolResults, req.directives), system, names);
    } finally {
      request("DELETE", `/api/session/${sid}`).catch((e: any) => console.log(`[OC] temp session ${sid} not deleted:`, e.message));
    }
  }
  const entry = session(key);
  const run = entry.chain.then(async () => {
    const fresh = !entry.sessionID || entry.intercept !== intercept;
    if (fresh) {
      entry.sessionID = null;
      entry.turns = 0;
      entry.intercept = intercept;
    }
    const sid = (entry.sessionID ??= await createSession(modelId, intercept));
    onSession?.(sid);
    const base = entry.turns === 0 ? transcript || lastUserText : lastUserText;
    entry.turns += 1;
    return runPrompt(sid, prompt(base, req.toolResults, req.directives), system, names);
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
