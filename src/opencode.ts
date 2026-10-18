import { OC_BIN, OC_PASSWORD, OC_SERVER, OC_USERNAME, OC_WORKDIR, REQUEST_TIMEOUT } from "./config.ts";
import { HttpError, basicAuth, pump, randomHex, rid, sleep } from "./lib.ts";
import { announcedName, extractMessage, flattenDelta } from "./protocols.ts";
import {
  digestsOf,
  dropEchoedAssistant,
  globalRegistry,
  shouldSendToolBlock,
  toolsSignature,
} from "./registry.ts";

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

export const KNOWN_MODELS = [
  "big-pickle",
  "exo-free",
  "ling-3.0-flash-fin-free",
  "ling-3.1-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "space-bunny-free",
  "step-5-preview-free",
];

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedModels: string[] | null = null;
let cachedModelsAt = 0;

export async function listModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < MODELS_CACHE_TTL_MS) {
    return cachedModels;
  }
  try {
    const r = await request("GET", "/api/model");
    if (r.status === 200 && Array.isArray(r.json?.data)) {
      const found: string[] = r.json.data
        .filter((m: any) => m.providerID === "opencode")
        .filter((m: any) => {
          if (m.cost && (m.cost.input !== 0 || m.cost.output !== 0)) return false;
          if (m.status === "deprecated") return false;
          return true;
        })
        .map((m: any) => m.id || m.modelID)
        .filter(Boolean);
      if (found.length) {
        cachedModels = found;
        cachedModelsAt = now;
        return found;
      }
    }
  } catch {}

  cachedModels = [...KNOWN_MODELS];
  cachedModelsAt = now;
  return cachedModels;
}

export const modelCount = () => (cachedModels ? cachedModels.length : KNOWN_MODELS.length);

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
    agent: "bypass-lite",
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
 *  null when the turn ended by itself.
 *
 *  When `poll` is false (no client tools), /wait may return early while opencode's own
 *  built-in tools are still executing. In that case we loop /wait until the agentic
 *  loop is truly finished so the caller gets the model's final reply, not the mid-loop
 *  "Let me do X" stub. */
async function awaitTurn(sid: string, poll: boolean): Promise<{ asked: any; message: any }> {
  let done = false;
  let wake = () => {};
  const settled = new Promise<void>((r) => (wake = r));
  const watching = poll
    ? (async () => {
        while (!done) {
          const r = await request("GET", `/api/session/${sid}/permission`);
          const pending = (Array.isArray(r.json?.data) ? r.json.data : []).find((p: any) => p?.source?.type === "tool");
          if (pending) return { asked: pending, message: null };
          await Promise.race([sleep(POLL_MS), settled]);
        }
        return { asked: null, message: null };
      })()
    : new Promise<{ asked: any; message: any }>(() => {});
  const turn = (async () => {
    // Loop /wait so that if opencode's own built-in tools are running the proxy
    // stays parked until the full agentic loop completes, not just the first generation.
    while (true) {
      const wait = await request("POST", `/api/experimental/session/${sid}/wait`);
      if (wait.status !== 204 && wait.status !== 200) throw upstreamError(wait);
      const msg = await latestAssistant(sid);
      const parts: any[] = Array.isArray(msg?.content) ? msg.content : Array.isArray(msg?.parts) ? msg.parts : [];
      const stillRunning = parts.some((p: any) => {
        if (p?.type === "tool" || p?.type === "tool_use") {
          const st = p?.state?.status ?? p?.status;
          return !st || st === "running" || st === "pending";
        }
        return false;
      });
      if (!stillRunning) {
        done = true;
        wake();
        return { asked: null, message: msg };
      }
      await sleep(POLL_MS);
    }
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
    const { asked, message } = await awaitTurn(sid, intercept);
    if (asked) {
      await reject(sid, asked.id);
      text = pointElsewhere(asked.action, names);
      continue;
    }
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
  messages?: any[];
  tools?: any[];
  toolChoice?: any;
}) {
  const { key, modelId, system, transcript, lastUserText, onSession, messages, tools, toolChoice } = req;
  const names = req.toolNames ?? [];
  const intercept = names.length > 0;
  // The request, then what the caller ran in answer to it, then how to call it. The
  // directives go last because a model follows what it reads most recently.
  const prompt = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");

  // When messages are passed, use the transparent digest-prefix registry for multi-turn sessions
  if (Array.isArray(messages) && messages.length > 0) {
    const digests = digestsOf(messages);
    const toolsSig = toolsSignature(tools, toolChoice);
    const matched = globalRegistry.match(digests, toolsSig, key);

    if (matched) {
      const sid = matched.sid;
      onSession?.(sid);
      let tail = messages.slice(matched.digests.length);
      tail = dropEchoedAssistant(tail, matched.lastReply, matched.lastReasoning);
      const deltaText = flattenDelta(tail, matched);
      const sendTools = shouldSendToolBlock("delta", matched, names.length > 0, toolsSig);
      const toolDirectives = sendTools ? req.directives : undefined;
      const text = prompt(deltaText || lastUserText, req.toolResults, toolDirectives);

      try {
        const message = await runPrompt(sid, text, "", names);
        const ans = extractMessage(message);
        globalRegistry.record(digests, sid, ans.text, ans.reasoning, toolsSig, key);
        return message;
      } catch (err) {
        globalRegistry.markTainted(sid);
        throw err;
      }
    }

    const sid = await createSession(modelId, intercept);
    onSession?.(sid);
    const text = prompt(transcript || lastUserText, req.toolResults, req.directives);

    try {
      const message = await runPrompt(sid, text, system, names);
      const ans = extractMessage(message);
      globalRegistry.record(digests, sid, ans.text, ans.reasoning, toolsSig, key);
      return message;
    } catch (err) {
      request("DELETE", `/api/session/${sid}`).catch(() => {});
      throw err;
    }
  }

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

export interface EventHubStats {
  connId: number;
  state: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";
  subscribers: number;
  events: number;
  reconnects: number;
  bytes: number;
}

/** Single shared SSE reader on OpenCode's /api/event with reconnect watchdog and idle disconnect. */
export class EventHub {
  private subs = new Set<Watch>();
  private abortController: AbortController | null = null;
  private running = false;
  private idleTimer: any = null;
  private connId = 0;
  private state: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" = "DISCONNECTED";
  private eventCount = 0;
  private reconnectCount = 0;
  private byteCount = 0;
  public readonly getBaseUrl: () => string;
  public readonly getAuth: () => string | null;
  public readonly idleTimeoutMs: number;

  constructor(
    getBaseUrl: () => string,
    getAuth: () => string | null,
    idleTimeoutMs: number = 30_000
  ) {
    this.getBaseUrl = getBaseUrl;
    this.getAuth = getAuth;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  subscribe(watch: Watch): { close: () => void } {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.subs.add(watch);
    if (!this.running) {
      this.startLoop();
    }
    return {
      close: () => {
        this.subs.delete(watch);
        if (this.subs.size === 0 && this.running && !this.idleTimer) {
          this.idleTimer = setTimeout(() => {
            if (this.subs.size === 0) {
              this.stop();
            }
          }, this.idleTimeoutMs);
        }
      },
    };
  }

  stats(): EventHubStats {
    return {
      connId: this.connId,
      state: this.state,
      subscribers: this.subs.size,
      events: this.eventCount,
      reconnects: this.reconnectCount,
      bytes: this.byteCount,
    };
  }

  stop() {
    this.running = false;
    this.state = "DISCONNECTED";
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async startLoop() {
    this.running = true;
    let backoff = 1000;
    const maxBackoff = 15000;

    while (this.running && (this.subs.size > 0 || this.idleTimer)) {
      this.connId += 1;
      this.state = this.reconnectCount > 0 ? "RECONNECTING" : "CONNECTING";
      const ac = new AbortController();
      this.abortController = ac;
      const url = this.getBaseUrl() + "/api/event";
      const authHeader = this.getAuth();

      try {
        const res = await fetch(url, {
          headers: authHeader ? { Authorization: authHeader } : {},
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        this.state = "CONNECTED";
        backoff = 1000;

        let buf = "";
        await pump(res.body, (text) => {
          this.byteCount += text.length;
          buf += text;
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            this.dispatchFrame(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        });
      } catch (err: any) {
        if (ac.signal.aborted) break;
      } finally {
        if (this.abortController === ac) {
          this.abortController = null;
        }
      }

      if (!this.running || this.subs.size === 0) break;

      this.reconnectCount += 1;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }

    this.state = "DISCONNECTED";
    this.running = false;
  }

  private dispatchFrame(frame: string) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let ev: any;
    try { ev = JSON.parse(line.slice(5)); } catch { return; }
    this.eventCount += 1;
    const data = ev?.data || ev?.properties || {};
    if (!data.sessionID || typeof data.delta !== "string" || !data.delta) return;

    for (const watch of this.subs) {
      if (watch.sid && data.sessionID === watch.sid) {
        if (ev.type === "session.reasoning.delta") watch.sink.delta("reasoning", data.delta);
        else if (ev.type === "session.text.delta") watch.sink.delta("text", data.delta);
      }
    }
  }
}

export const globalEventHub = new EventHub(() => base, () => auth);

/** Tails the backend's event stream and pushes this request's deltas into the sink.
 *  Uses globalEventHub so all concurrent requests share one persistent SSE connection. */
export function connectEvents(watch: Watch) {
  return globalEventHub.subscribe(watch);
}

const BYPASS_LITE_AGENT = `---
description: Completion backend for the proxy; emits <tool_call> blocks when the client offers tools.
mode: primary
---
You are a completion backend behind an OpenAI-compatible proxy. The entire conversation, including any prior tool activity, arrives as one labeled transcript; the backend's session state already holds earlier turns, so later prompts may contain only the newest messages.

Respond as the assistant to the latest user turn. Match the conversation's language and tone. Do not ask the user questions, do not start tasks/plans/todos, and do not invoke the backend's built-in tool runner — the caller owns all tool orchestration.

When the prompt includes a \`[client tools]\` section, you may need one or more of those tools. To call a tool, emit exactly this block (JSON object on one line is fine):

<tool_call>
{"name": "tool_name", "arguments": {"key": "value"}}
</tool_call>

Rules:
- \`arguments\` must be a JSON object matching that tool's \`parameters\` schema.
- Exactly one JSON object per tool call.
- One block per tool call; normal text may appear before or after blocks.
- Do not use markdown fences around the tool call.
- Do not emit additional wrapper text inside the tool-call block.
- Only use tools listed under \`[client tools]\`; never invent tools.
- Never emit \`<tool_call>\` when that section is absent — answer directly in text.
- Never wrap answers in think tags — the proxy handles reasoning as a separate \`reasoning_content\` channel; your visible text is the final answer only.
- The proxy converts your blocks into the client's OpenAI \`tool_calls\` format; you will see tool results arrive as \`[tool result: ...]\` turns on the next prompt.
- Legacy \`[tool_call]...[/tool_call]\` syntax is still accepted for backward compatibility, but prefer \`<tool_call>...</tool_call>\`.
`;

/** Brings the backend up: reuses OC_SERVER when one is configured, otherwise spawns
 *  `opencode serve` and waits until it answers. */
export async function start() {
  if (OC_SERVER) {
    base = OC_SERVER.replace(/\/$/, "");
    auth = OC_PASSWORD ? basicAuth(OC_USERNAME, OC_PASSWORD) : null;
    return;
  }
  if (OC_BIN === "opencode" && !Bun.which("opencode")) throw new Error("opencode binary not found - set OC_BIN or install opencode");
  const mkdir = Bun.spawn(["mkdir", "-p", `${OC_WORKDIR}/.opencode/agents`], { stdout: "ignore", stderr: "ignore" });
  if ((await mkdir.exited) !== 0) throw new Error(`could not create OC_WORKDIR: ${OC_WORKDIR}`);
  await Bun.write(`${OC_WORKDIR}/.opencode/agents/bypass-lite.md`, BYPASS_LITE_AGENT);

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
