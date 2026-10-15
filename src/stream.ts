import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Context } from "hono";
import { describeError, nowSeconds, rid } from "./lib.ts";
import { connectEvents } from "./opencode.ts";
import { anthropicStopReason, extractAnswer, openaiFinish, openaiToolCall, openaiUsage, sendFailure, toolArguments, type Answer, type Failure, type ToolCall } from "./protocols.ts";

/** The two streaming sinks and the relay that connects them to a request. A sink
 *  writes provider-shaped SSE frames into a buffer and only reaches the client once
 *  the relay attaches it to the response stream. */

type Kind = "text" | "reasoning";

export interface Sink {
  /** Resolves with the first frame. This is what lets a streaming request wait for the
   *  model instead of answering with an error on an empty 200. */
  readonly whenOpened: Promise<void>;
  attach(sse: SSEStreamingApi): void;
  delta(kind: Kind, text: string): void;
  finish(answer: Answer): Promise<unknown>;
  fail(message: string): Promise<unknown>;
}

/** Frames are buffered until the relay attaches the response stream. That is what
 *  lets the request answer with a plain JSON error while nothing has reached the
 *  client yet, and commit to SSE only once the first token is on the wire. */
function buffer() {
  const queue: { data: string; event?: string }[] = [];
  let response: SSEStreamingApi | null = null;
  let opened = false;
  let markOpened!: () => void;
  const whenOpened = new Promise<void>((resolve) => { markOpened = resolve; });
  // Hono closes the stream as soon as its callback returns, so writes are chained
  // and `flush` is what guarantees the last frames are on the wire by then.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (frame: { data: string; event?: string }) => { chain = chain.then(() => response?.writeSSE(frame)); };
  return {
    whenOpened,
    get opened() { return opened; },
    attach(sse: SSEStreamingApi) {
      response = sse;
      for (const frame of queue) enqueue(frame);
      queue.length = 0;
    },
    send(data: string, event?: string) {
      if (response?.aborted) return false;
      if (!opened) { opened = true; markOpened(); }
      const frame = { data, ...(event ? { event } : {}) };
      if (response) enqueue(frame);
      else queue.push(frame);
      return true;
    },
    flush: () => chain,
  };
}

/** What a sink already streamed, so the full answer the backend returns at the end only
 *  has to send the part the client has not seen yet. */
function tail() {
  const sent: Record<Kind, string> = { text: "", reasoning: "" };
  return {
    record: (kind: Kind, value: string) => { sent[kind] += value; },
    unseen: (full: string | undefined, kind: Kind = "text") => {
      const done = sent[kind];
      return !done ? full || "" : full?.startsWith(done) ? full.slice(done.length) : "";
    },
  };
}

export const openaiSink = (modelId: string): Sink => {
  const id = rid("chatcmpl-");
  const created = nowSeconds();
  const out = buffer();
  const seen = tail();
  let sentTool = false;
  const chunk = (delta: object, finish?: string, usage?: object) =>
    out.send(JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    }));
  const open = () => out.opened || chunk({ role: "assistant" });
  // A tool call is a single frame: the client needs the name and the whole argument
  // string together to run it.
  const tool = (call: ToolCall) => {
    if (sentTool) return;
    sentTool = true;
    if (!open()) return;
    chunk({ tool_calls: [{ index: 0, ...openaiToolCall(call) }] });
  };

  return {
    whenOpened: out.whenOpened,
    attach: out.attach,
    delta(kind, text) {
      if (!open()) return;
      seen.record(kind, text);
      chunk(kind === "reasoning" ? { reasoning_content: text } : { content: text });
    },
    finish(answer) {
      if (!open()) return out.flush();
      const reasoning = seen.unseen(answer.reasoning, "reasoning");
      const text = seen.unseen(answer.text);
      if (reasoning) chunk({ reasoning_content: reasoning });
      if (text) chunk({ content: text });
      if (answer.toolCall) tool(answer.toolCall);
      chunk({}, openaiFinish(answer), openaiUsage(answer));
      out.send("[DONE]");
      return out.flush();
    },
    fail(message) {
      if (!open()) return out.flush();
      out.send(JSON.stringify({ error: { message } }));
      out.send("[DONE]");
      return out.flush();
    },
  };
};

export const anthropicSink = (modelId: string): Sink => {
  const id = rid("msg_");
  const out = buffer();
  const seen = tail();
  let block: string | null = null;
  let tool: ToolCall | null = null;
  let index = -1;
  const send = (event: string, data: object) => out.send(JSON.stringify(data), event);
  const openBlock = (type: string, call?: ToolCall) => {
    if (block === type && (!call || tool?.id === call.id)) return;
    if (block) send("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    block = type;
    tool = call ?? null;
    send("content_block_start", {
      type: "content_block_start", index,
      content_block:
        type === "thinking" ? { type: "thinking", thinking: "" }
        : type === "tool" ? { type: "tool_use", id: call?.id, name: call?.name, input: {} }
        : { type: "text", text: "" },
    });
  };
  const open = () => out.opened || send("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", content: [], model: modelId,
      stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  const emit = (type: string, text: string) => {
    openBlock(type);
    send("content_block_delta", {
      type: "content_block_delta", index,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  // A tool_use block carries its arguments as one input_json_delta holding the whole
  // object, which is what the client needs to run the call.
  const emitTool = (call: ToolCall) => {
    openBlock("tool", call);
    send("content_block_delta", {
      type: "content_block_delta", index,
      delta: { type: "input_json_delta", partial_json: toolArguments(call) },
    });
  };

  return {
    whenOpened: out.whenOpened,
    attach: out.attach,
    delta(kind, text) {
      if (!open()) return;
      seen.record(kind, text);
      emit(kind === "reasoning" ? "thinking" : "text", text);
    },
    finish(answer) {
      if (!open()) return out.flush();
      const reasoning = seen.unseen(answer.reasoning, "reasoning");
      const text = seen.unseen(answer.text);
      if (reasoning) emit("thinking", reasoning);
      if (text) emit("text", text);
      if (answer.toolCall) emitTool(answer.toolCall);
      if (block) send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: anthropicStopReason(answer) },
        usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      return out.flush();
    },
    fail(message) {
      if (!open()) return out.flush();
      send("error", { type: "error", error: { type: "api_error", message } });
      return out.flush();
    },
  };
}

/** Answers one streaming request. A sink reaches the client only once it is attached to
 *  the response stream, so the relay holds the response back until the first token
 *  arrives. A relay that fails before that is still reported as a normal JSON error
 *  with a real status code instead of an SSE frame on a 200.
 *
 *  `live` is false for a request whose answer may turn out to be a tool call: there is
 *  nothing to stream until the turn ends, so no event tail is opened and the whole
 *  answer goes out at once. */
export async function relay(
  c: Context,
  sink: Sink,
  run: (onSession?: (sid: string) => void) => Promise<any>,
  fail: (e: unknown) => Failure,
  live = true
) {
  if (!live) return once(c, sink, await settle(run()), fail);

  const watch = { sid: null as string | null, sink };
  const conn = connectEvents(watch);
  const close = () => conn.close();
  c.req.raw.signal.addEventListener("abort", close);

  const settled = settle(run((sid) => { watch.sid = sid; }));
  const started = await Promise.race([sink.whenOpened.then(() => true), settled.then(() => false)]);

  if (!started) {
    close();
    return once(c, sink, await settled, fail);
  }

  return commit(c, async (sse) => {
    sse.onAbort(close);
    try {
      sink.attach(sse);
      const done = await settled;
      if (done.error) await sink.fail(describeError(done.error).message);
      else await sink.finish(extractAnswer(done.result));
    } finally {
      close();
    }
  });
}

const settle = (run: Promise<any>): Promise<{ result?: any; error?: any }> =>
  run.then((result) => ({ result }), (error) => ({ error }));

/** The answer, given as one piece: what a sink already streamed is finished here, and a
 *  turn that said nothing at all is a failure rather than an empty 200. */
async function once(c: Context, sink: Sink, done: { result?: any; error?: any }, fail: (e: unknown) => Failure) {
  if (done.error) return sendFailure(c, fail, done.error);
  const answer = extractAnswer(done.result);
  if (!answer.text && !answer.reasoning && !answer.toolCall) {
    return sendFailure(c, fail, new Error("empty response from opencode"));
  }
  return commit(c, async (sse) => {
    sink.attach(sse);
    await sink.finish(answer);
  });
}

const commit = (c: Context, write: (sse: SSEStreamingApi) => Promise<void>) => {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, write);
};
