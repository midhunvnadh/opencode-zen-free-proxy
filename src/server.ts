// @ts-nocheck
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { jsonBody } from "./lib/http.ts";
import { PORT } from "./config.ts";
import { loadKeys, apiKeys } from "./keys.ts";
import * as backend from "./backend.ts";
import * as models from "./models.ts";
import * as prompts from "./prompts.ts";
import * as sessions from "./sessions.ts";
import * as messages from "./messages.ts";
import * as sinks from "./sinks.ts";
import { connectEvents } from "./events.ts";

const app = new Hono();

const openaiError = (e: any) => ({ error: { message: e.message, type: "upstream_error" } });
const anthropicError = (e: any) => ({
  type: "error",
  error: { type: e.status === 429 ? "rate_limit_error" : "upstream_error", message: e.message },
});

// A sink reaches the client only once it is attached to a response stream, so the
// relay holds the response back until the first token arrives. A relay that fails
// before that is still reported as a normal JSON error with a real status code
// instead of an SSE frame on a 200.
async function streamRelay(c: any, watch: any, run: () => Promise<any>, errorBody: (e: any) => any) {
  const sink = watch.sink;
  watch.conn = connectEvents(watch);
  const close = () => watch.conn.close();
  c.req.raw.signal.addEventListener("abort", close);

  const settled = run().then(
    (result: any) => ({ result }),
    (error: any) => ({ error })
  );
  const started = await Promise.race([sink.whenOpened.then(() => true), settled.then(() => false)]);

  if (!started) {
    close();
    const done = await settled;
    if (done.error) return c.json(errorBody(done.error), done.error.status || 502);
    const extracted = messages.extractMessage(done.result?.json);
    if (!extracted.text && !extracted.reasoning) {
      return c.json(errorBody(new Error("empty response from opencode")), 502);
    }
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => { sink.attach(stream); return sink.finish(extracted); });
  }

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    stream.onAbort(close);
    try {
      sink.attach(stream);
      const done = await settled;
      if (done.error) return sink.fail(done.error.message);
      return sink.finish(messages.extractMessage(done.result?.json));
    } finally {
      close();
    }
  });
}

app.get("/health", (c) =>
  c.json({ status: "ok", opencode: backend.ocBaseValue(), models: models.modelCacheCount() })
);

app.get("/v1/models", async (c) => {
  const modelList = await models.getModels();
  return c.json({
    object: "list",
    data: modelList.map((id: string) => ({ id, object: "model", created: 1779000000, owned_by: "opencode" })),
  });
});

app.get("/v1/models/:model", async (c) => {
  const modelId = c.req.param("model");
  const modelList = await models.getModels();
  if (!modelList.includes(modelId)) {
    return c.json({ error: { message: "Model not found", type: "invalid_request_error" } }, 404);
  }
  return c.json({ id: modelId, object: "model", created: 1779000000, owned_by: "opencode" });
});

app.post("/v1/chat/completions", async (c) => {
  const { model, messages: msgs, stream, user: userId } = await jsonBody(c);
  const modelId = String(model || "").replace(/^opencode\//, "");
  const modelList = await models.getModels();
  if (!modelList.includes(modelId)) {
    return c.json({ error: { message: `Unknown model: ${modelId}. Available: ${modelList.join(", ")}`, type: "upstream_error" } }, 400);
  }
  const { system, transcript, lastUserText } = prompts.messagesToPrompt(msgs);
  if (!lastUserText) {
    return c.json({ error: { message: "No user message in request", type: "upstream_error" } }, 400);
  }
  const key = c.req.header("x-oc-session") || userId || null;

  if (stream) {
    const watch = { sid: null, sink: sinks.openaiSink(modelId), conn: null };
    return streamRelay(
      c,
      watch,
      () => sessions.ask({ key, system, modelId, transcript, lastUserText, onSession: (sid: string) => { watch.sid = sid; } }),
      openaiError
    );
  }

  try {
    const r = await sessions.ask({ key, system, modelId, transcript, lastUserText });
    if (r.status !== 200) throw sessions.upstreamError(r);
    const extracted = messages.extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning) throw new Error("empty response from opencode");
    return c.json(messages.openaiResponse(modelId, extracted));
  } catch (e: any) {
    return c.json(openaiError(e), e.status || 502);
  }
});

app.post("/v1/messages", async (c) => {
  const body = await jsonBody(c);
  const { model, stream, metadata } = body;
  const modelId = String(model || "").replace(/^opencode\//, "");
  const modelList = await models.getModels();
  if (!modelList.includes(modelId)) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: `Unknown model: ${modelId}. Available: ${modelList.join(", ")}` } }, 400);
  }
  const { system, transcript, lastUserText } = prompts.anthropicToPrompt(body);
  if (!lastUserText) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "No user message in request" } }, 400);
  }
  const key = c.req.header("x-oc-session") || metadata?.user_id || null;

  if (stream) {
    const watch = { sid: null, sink: sinks.anthropicSink(modelId), conn: null };
    return streamRelay(
      c,
      watch,
      () => sessions.ask({ key, system, modelId, transcript, lastUserText, onSession: (sid: string) => { watch.sid = sid; } }),
      anthropicError
    );
  }

  try {
    const r = await sessions.ask({ key, system, modelId, transcript, lastUserText });
    if (r.status !== 200) throw sessions.upstreamError(r);
    const extracted = messages.extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning) throw new Error("empty response from opencode");
    return c.json(messages.anthropicResponse(modelId, extracted));
  } catch (e: any) {
    return c.json(anthropicError(e), e.status || 502);
  }
});

app.notFound((c) =>
  c.json({
    error: { message: `Unknown route ${c.req.method} ${new URL(c.req.url).pathname}`, type: "invalid_request_error", param: null, code: null },
  }, 404)
);

app.onError((e, c) => {
  console.error(e);
  return c.json({ error: { message: e?.message || String(e), type: "upstream_error" } }, 500);
});

// Bun closes a connection after idleTimeout seconds of silence (default 10), which
// would cut off a slow model mid-answer, so POSTs opt out per request.
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  fetch(req, srv) {
    if (req.method === "POST") srv.timeout(req, 0);
    return app.fetch(req);
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await server.stop(true); process.exit(0); });
}

console.log(`openai compat proxy on http://0.0.0.0:${PORT}`);
await loadKeys();
try {
  await backend.startBackend();
  const modelList = await models.getModels();
  console.log("  Models:", modelList.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) console.log(`  ${name.padEnd(15)} ${key}`);
} catch (e: any) {
  console.error("  Failed to start opencode backend:", e.message);
  process.exit(1);
}