// @ts-nocheck
import type { SSEStream } from "hono/streaming";
import { mapFinish, anthropicStopReason } from "./messages.ts";
import { rid } from "./lib/id.ts";
import { nowSeconds } from "./lib/time.ts";

function remainingText(full: any, sent: any): string {
  return !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
}

// Frames are buffered until the route attaches the response stream. That is what
// lets the route answer with a plain JSON error while nothing has reached the
// client yet, and commit to SSE only once the first token is on the wire.
function buffer() {
  const queue: { data: string; event?: string }[] = [];
  let response: SSEStream | null = null;
  let opened = false;
  let markOpened!: () => void;
  const whenOpened = new Promise<void>((resolve) => { markOpened = resolve; });
  // Hono closes the stream as soon as its callback returns, so writes are chained
  // and `flush` is what guarantees the last frames are on the wire by then.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (frame: { data: string; event?: string }) => {
    chain = chain.then(() => response?.writeSSE(frame));
  };
  return {
    whenOpened,
    get opened() { return opened; },
    attach(sse: SSEStream) {
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
    flush() { return chain; },
  };
}

export function openaiSink(modelId: string) {
  const id = rid("chatcmpl-");
  const created = nowSeconds();
  const out = buffer();
  let sentText = "";
  let sentReasoning = "";
  const chunk = (delta: any, finish?: any, usage?: any) =>
    out.send(JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    }));
  const open = () => out.opened || chunk({ role: "assistant" });
  return {
    whenOpened: out.whenOpened,
    get opened() { return out.opened; },
    attach: out.attach,
    delta(kind: string, text: string) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; chunk({ reasoning_content: text }); }
      else { sentText += text; chunk({ content: text }); }
    },
    finish(r: any) {
      if (!open()) return;
      const reasoning = remainingText(r.reasoning, sentReasoning);
      const text = remainingText(r.text, sentText);
      if (reasoning) chunk({ reasoning_content: reasoning });
      if (text) chunk({ content: text });
      chunk({}, mapFinish(r.finish), {
        prompt_tokens: r.inputTokens,
        completion_tokens: r.outputTokens,
        total_tokens: r.inputTokens + r.outputTokens,
      });
      out.send("[DONE]");
      return out.flush();
    },
    fail(message: string) {
      if (!open()) return;
      out.send(JSON.stringify({ error: { message } }));
      out.send("[DONE]");
      return out.flush();
    },
  };
}

export function anthropicSink(modelId: string) {
  const id = rid("msg_");
  const out = buffer();
  let block: string | null = null;
  let index = -1;
  let sentText = "";
  let sentReasoning = "";
  const send = (event: string, data: any) => out.send(JSON.stringify(data), event);
  const openBlock = (type: string) => {
    if (block === type) return;
    if (block) send("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    block = type;
    send("content_block_start", {
      type: "content_block_start",
      index,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
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
      type: "content_block_delta",
      index,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  return {
    whenOpened: out.whenOpened,
    get opened() { return out.opened; },
    attach: out.attach,
    delta(kind: string, text: string) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; emit("thinking", text); }
      else { sentText += text; emit("text", text); }
    },
    finish(r: any) {
      if (!open()) return;
      const reasoning = remainingText(r.reasoning, sentReasoning);
      const text = remainingText(r.text, sentText);
      if (reasoning) { sentReasoning += reasoning; emit("thinking", reasoning); }
      if (text) { sentText += text; emit("text", text); }
      if (block) send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: anthropicStopReason(r.finish) },
        usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      return out.flush();
    },
    fail(message: string) {
      if (!open()) return;
      send("error", { type: "error", error: { type: "api_error", message } });
      return out.flush();
    },
  };
}