// @ts-nocheck
import http from "http";
import { PORT } from "./config.ts";
import { readBody, sendJson } from "./lib/http.ts";
import { loadKeys, apiKeys } from "./keys.ts";
import * as backend from "./backend.ts";
import * as models from "./models.ts";
import * as prompts from "./prompts.ts";
import * as sessions from "./sessions.ts";
import * as messages from "./messages.ts";
import * as sinks from "./sinks.ts";
import { connectEvents } from "./events.ts";

const oc = backend;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    if (method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok", opencode: backend.ocBaseValue(), models: models.modelCacheCount() });
    }

    if (method === "GET" && pathname === "/v1/models") {
      const modelList = await models.getModels();
      return sendJson(res, 200, {
        object: "list",
        data: modelList.map((id: string) => ({ id, object: "model", created: 1779000000, owned_by: "opencode" })),
      });
    }

    const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
    if (method === "GET" && modelMatch) {
      const modelId = decodeURIComponent(modelMatch[1]);
      const modelList = await models.getModels();
      if (!modelList.includes(modelId)) {
        return sendJson(res, 404, { error: { message: "Model not found", type: "invalid_request_error" } });
      }
      return sendJson(res, 200, { id: modelId, object: "model", created: 1779000000, owned_by: "opencode" });
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      let sink: any = null;
      let watch: any = null;
      try {
        const { model, messages: msgs, stream, user: userId } = body || {};
        const modelId = String(model || "").replace(/^opencode\//, "");
        const modelList = await models.getModels();
        if (!modelList.includes(modelId)) {
          return sendJson(res, 400, { error: { message: `Unknown model: ${modelId}. Available: ${modelList.join(", ")}`, type: "upstream_error" } });
        }
        const { system, transcript, lastUserText } = prompts.messagesToPrompt(msgs);
        if (!lastUserText) {
          return sendJson(res, 400, { error: { message: "No user message in request", type: "upstream_error" } });
        }
        const key = req.headers["x-oc-session"] || userId || null;
        if (stream) {
          sink = sinks.openaiSink(res, modelId);
          watch = { sid: null, types: new Map(), sink, conn: null };
          watch.conn = connectEvents(watch);
          req.on("close", () => watch?.conn?.close());
        }
        const r = await sessions.ask({ key, system, modelId, transcript, lastUserText, onSession: (sid: string) => { if (watch) watch.sid = sid; } });
        if (r.status !== 200) throw sessions.upstreamError(r);
        const extracted = messages.extractMessage(r.json);
        if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
          throw new Error("empty response from opencode");
        }
        if (stream) return sink.finish(extracted);
        return sendJson(res, 200, messages.openaiResponse(modelId, extracted));
      } catch (e: any) {
        if (sink && sink.opened) return sink.fail(e.message);
        return sendJson(res, e.status || 502, { error: { message: e.message, type: "upstream_error" } });
      } finally {
        watch?.conn?.close();
      }
    }

    if (method === "POST" && pathname === "/v1/messages") {
      const body = await readBody(req);
      let sink: any = null;
      let watch: any = null;
      try {
        const { model, stream, metadata } = body || {};
        const modelId = String(model || "").replace(/^opencode\//, "");
        const modelList = await models.getModels();
        if (!modelList.includes(modelId)) {
          return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: `Unknown model: ${modelId}. Available: ${modelList.join(", ")}` } });
        }
        const { system, transcript, lastUserText } = prompts.anthropicToPrompt(body);
        if (!lastUserText) {
          return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "No user message in request" } });
        }
        const key = req.headers["x-oc-session"] || metadata?.user_id || null;
        if (stream) {
          sink = sinks.anthropicSink(res, modelId);
          watch = { sid: null, types: new Map(), sink, conn: null };
          watch.conn = connectEvents(watch);
          req.on("close", () => watch?.conn?.close());
        }
        const r = await sessions.ask({ key, system, modelId, transcript, lastUserText, onSession: (sid: string) => { if (watch) watch.sid = sid; } });
        if (r.status !== 200) throw sessions.upstreamError(r);
        const extracted = messages.extractMessage(r.json);
        if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
          throw new Error("empty response from opencode");
        }
        if (stream) return sink.finish(extracted);
        return sendJson(res, 200, messages.anthropicResponse(modelId, extracted));
      } catch (e: any) {
        if (sink && sink.opened) return sink.fail(e.message);
        return sendJson(res, e.status || 502, { type: "error", error: { type: e.status === 429 ? "rate_limit_error" : "upstream_error", message: e.message } });
      } finally {
        watch?.conn?.close();
      }
    }

    return sendJson(res, 404, { error: { message: `Unknown route ${method} ${pathname}`, type: "invalid_request_error", param: null, code: null } });
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: { message: e?.message || String(e), type: "upstream_error" } });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`openai compat proxy on http://0.0.0.0:${PORT}`);
  try {
    await backend.startBackend();
    const modelList = await models.getModels();
    console.log("  Models:", modelList.join(", "));
    for (const [name, key] of Object.entries(apiKeys)) console.log(`  ${name.padEnd(15)} ${key}`);
  } catch (e: any) {
    console.error("  Failed to start opencode backend:", e.message);
    process.exit(1);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

loadKeys();