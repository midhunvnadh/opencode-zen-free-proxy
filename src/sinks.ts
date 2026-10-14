// @ts-nocheck
import { mapFinish, anthropicStopReason } from "./messages.ts";
import { rid } from "./lib/id.ts";
import { nowSeconds } from "./lib/time.ts";
import { writeSafe, sseHead } from "./lib/sse.ts";

function remainingText(full: any, sent: any): string {
  return !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
}
export function openaiSink(res: any, modelId: string) {
  const id = rid("chatcmpl-");
  const created = nowSeconds();
  let opened = false;
  let sentText = "";
  let sentReasoning = "";
  const chunk = (delta: any, finish: any, usage: any) =>
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    writeSafe(res, chunk({ role: "assistant" }));
    return true;
  };
  return {
    get opened() { return opened; },
    delta(kind: string, text: string) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; writeSafe(res, chunk({ reasoning_content: text })); }
      else { sentText += text; writeSafe(res, chunk({ content: text })); }
    },
    finish(r: any) {
      if (!open()) return;
      const reasoning = remainingText(r.reasoning, sentReasoning);
      const text = remainingText(r.text, sentText);
      if (reasoning) writeSafe(res, chunk({ reasoning_content: reasoning }));
      if (text) writeSafe(res, chunk({ content: text }));
      writeSafe(res, chunk({}, mapFinish(r.finish), {
        prompt_tokens: r.inputTokens,
        completion_tokens: r.outputTokens,
        total_tokens: r.inputTokens + r.outputTokens,
      }));
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
    fail(message: string) {
      if (!open()) return;
      writeSafe(res, `data: ${JSON.stringify({ error: { message } })}\n\n`);
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
  };
}

export function anthropicSink(res: any, modelId: string) {
  const id = rid("msg_");
  let opened = false;
  let block: string | null = null;
  let index = -1;
  let sentText = "";
  let sentReasoning = "";
  const send = (event: string, data: any) => writeSafe(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    send("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model: modelId,
        stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    return true;
  };
  const emit = (type: string, text: string) => {
    openBlock(type);
    send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  return {
    get opened() { return opened; },
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
      try { res.end(); } catch {}
    },
    fail(message: string) {
      if (!open()) return;
      send("error", { type: "error", error: { type: "api_error", message } });
      try { res.end(); } catch {}
    },
  };
}
