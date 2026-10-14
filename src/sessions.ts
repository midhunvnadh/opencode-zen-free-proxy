// @ts-nocheck
import { ocReq } from "./backend.ts";

const sessions = new Map();
export function sessionEntry(key: string) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, turns: 0, chain: Promise.resolve() });
  return sessions.get(key);
}

export function upstreamError(r: any) {
  const msg =
    r.json?.data?.message ||
    r.json?.error?.message ||
    r.json?.message ||
    `opencode server returned ${r.status}`;
  const err: any = new Error(msg);
  err.status = r.status === 429 ? 429 : r.status === 400 ? 400 : r.status === 401 ? 401 : 502;
  return err;
}

export async function createSession(modelId: string) {
  const r: any = await ocReq("POST", "/api/session", {
    title: "proxy", agent: "build", model: { id: modelId, providerID: "opencode" },
  });
  if (r.status !== 200) throw upstreamError(r);
  const sid = r.json?.data?.id;
  if (!sid) throw new Error("opencode did not return a session id");
  return sid;
}

export async function waitSession(sid: string) {
  const r: any = await ocReq("POST", `/api/experimental/session/${sid}/wait`);
  if (r.status !== 204 && r.status !== 200) throw upstreamError(r);
}

export async function fetchAssistant(sid: string) {
  const r: any = await ocReq("GET", `/api/session/${sid}/message`);
  if (r.status !== 200) throw upstreamError(r);
  const msgs = Array.isArray(r.json?.data) ? r.json.data : [];
  const assistants = msgs.filter((m: any) => m?.type === "assistant");
  if (!assistants.length) throw new Error("no assistant reply from opencode");
  return assistants.reduce((a: any, b: any) =>
    (a?.time?.created || 0) < (b?.time?.created || 0) ? b : a
  );
}

async function runPrompt(sid: string, baseText: string, system: any) {
  let text = baseText;
  if (system) text = `System: ${system}\\n\\n${text}`;
  const pr: any = await ocReq("POST", `/api/session/${sid}/prompt`, { text });
  if (pr.status !== 200 && pr.status !== 202) throw upstreamError(pr);
  await waitSession(sid);
  return fetchAssistant(sid);
}

export async function ask(params: any) {
  const { key, system, modelId, transcript, lastUserText, onSession } = params;
  if (!key) {
    const sid = await createSession(modelId);
    onSession?.(sid);
    try {
      const assistant = await runPrompt(sid, transcript || lastUserText, system);
      return { status: 200, json: assistant };
    } finally {
      ocReq("DELETE", `/api/session/${sid}`).catch((e: any) =>
        console.log(`[OC] temp session ${sid} not deleted:`, e.message)
      );
    }
  }
  const entry: any = sessionEntry(key);
  const run = entry.chain.then(async () => {
    if (!entry.sessionID) {
      entry.sessionID = await createSession(modelId);
      entry.turns = 0;
    }
    onSession?.(entry.sessionID);
    const base = entry.turns === 0 ? (transcript || lastUserText) : lastUserText;
    entry.turns++;
    const assistant = await runPrompt(entry.sessionID, base, system);
    return { status: 200, json: assistant };
  });
  entry.chain = run.catch(() => {});
  return run;
}
