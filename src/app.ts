import { Hono, type Context, type Handler } from "hono";
import { logger } from "hono/logger";
import { anthropic, openai } from "./dialects.ts";
import { HttpError, nowSeconds } from "./lib.ts";
import { dialect, resolveModel, withBody, type Env } from "./middleware.ts";
import { askModel, listModels, modelCount, ocBase } from "./opencode.ts";
import { extractAnswer, openaiFailure, sendFailure, toolInstructions, toolResultPrompt } from "./protocols.ts";
import { relay } from "./stream.ts";

/** The conversation key: an explicit header wins, else the user field each provider
 *  carries it under. Without one, every turn is its own stateless session. */
const sessionKey = (c: Context<Env>, body: any) =>
  c.req.header("x-oc-session") || body.user || body.metadata?.user_id || null;

const modelInfo = (id: string) => ({ id, object: "model", created: nowSeconds(), owned_by: "opencode" });

/** One completion, in whichever dialect the route selected: stream it or answer
 *  with the whole message, same code path for both providers. */
const completion: Handler<Env> = async (c) => {
  const d = c.get("dialect");
  const body = c.get("body");
  const modelId = c.get("modelId");
  const { system, transcript, lastUserText, tools } = d.prompt(body);
  const names = tools.declared.map((t) => t.name);
  // A request that only carries a tool result is the next step of a turn already in
  // flight, not an empty request.
  if (!lastUserText && !tools.results.length) throw new HttpError(400, "No user message in request", "invalid_request_error");

  const ask = (onSession?: (sid: string) => void) =>
    askModel({
      key: sessionKey(c, body),
      modelId,
      system,
      directives: toolInstructions(tools.declared),
      transcript,
      lastUserText,
      toolNames: names,
      toolResults: toolResultPrompt(tools.results),
      onSession,
    });

  // A model announces a tool call in the same text as its answer, so a request that
  // offers tools cannot stream as it goes: the client would be handed both the call and
  // the prose around it. It waits and is answered in one piece.
  if (body.stream) return relay(c, d.sink(modelId), ask, d.fail, names);

  const answer = extractAnswer(await ask(), names);
  if (!answer.text && !answer.reasoning && !answer.toolCall) throw new HttpError(502, "empty response from opencode");
  return c.json(d.response(modelId, answer));
};

export function createApp() {
  const app = new Hono<Env>();
  // Everything that has not been matched a dialect is reported the OpenAI way.
  const fail = (c: Context<Env>) => c.get("dialect")?.fail ?? openaiFailure;

  app.use(logger());

  app.get("/health", (c) => c.json({ status: "ok", opencode: ocBase(), models: modelCount() }));
  app.get("/v1/models", async (c) => c.json({ object: "list", data: (await listModels()).map(modelInfo) }));
  app.get("/v1/models/:model", resolveModel, (c) => c.json(modelInfo(c.get("modelId"))));

  app.post("/v1/chat/completions", dialect(openai), withBody, resolveModel, completion);
  app.post("/v1/messages", dialect(anthropic), withBody, resolveModel, completion);

  app.notFound((c) =>
    sendFailure(c, fail(c), new HttpError(404, `Unknown route ${c.req.method} ${new URL(c.req.url).pathname}`, "invalid_request_error"))
  );
  // Failures that arrived as an HttpError are the client's business and stay quiet;
  // anything else is a bug: log it and report an internal error.
  app.onError((e, c) => {
    if (e instanceof HttpError) return sendFailure(c, fail(c), e);
    console.error(e);
    return sendFailure(c, fail(c), new HttpError(500, e instanceof Error ? e.message : String(e)));
  });

  return app;
}
