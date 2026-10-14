import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError, nowSeconds, rid } from "./lib.ts";

/** The two wire formats this proxy speaks, as plain data: request bodies and backend
 *  answers in, provider responses and error envelopes out. */

export interface Answer {
  text: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  finish?: string;
}

export interface Prompt {
  system: string;
  transcript: string;
  lastUserText: string;
}

export interface Failure {
  status: number;
  body: object;
}

/** Message content is plain text, plus whatever blocks a tool result came back as. */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => part.type === "text" ? part.text ?? "" : part.type === "tool_result" ? extractText(part.content) : "")
    .filter(Boolean)
    .join("\n");
}

/** Flattens a conversation into one prompt: the system instructions, the whole
 *  transcript, and the last user turn on its own. */
export function toPrompt(messages: any[]): Prompt {
  let system = "";
  const turns: string[] = [];
  for (const m of messages ?? []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText = [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

export function anthropicPrompt(body: any): Prompt {
  // Anthropic keeps the system prompt next to the messages, not inside them.
  return { ...toPrompt(body.messages), system: extractText(body.system) };
}

/** Flattens an assistant message from the backend into text, reasoning and usage. */
export function extractMessage(message: any): Answer {
  const parts = Array.isArray(message?.content) ? message.content : Array.isArray(message?.parts) ? message.parts : [];
  let text = "";
  let reasoning = "";
  for (const p of parts) {
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "reasoning") reasoning += p.text ?? "";
  }
  const tokens = message?.tokens || message?.info?.tokens || {};
  return {
    text,
    reasoning,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    finish: message?.finish ?? message?.info?.finish,
  };
}

export const openaiFinish = (finish?: string) => (finish === "length" ? "length" : "stop");
export const anthropicStopReason = (finish?: string) => (finish === "length" ? "max_tokens" : "end_turn");
export const openaiUsage = (a: Answer) => ({
  prompt_tokens: a.inputTokens,
  completion_tokens: a.outputTokens,
  total_tokens: a.inputTokens + a.outputTokens,
});

export function openaiResponse(modelId: string, a: Answer): object {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: nowSeconds(),
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: a.text, ...(a.reasoning ? { reasoning_content: a.reasoning } : {}) },
        finish_reason: openaiFinish(a.finish),
      },
    ],
    usage: openaiUsage(a),
  };
}

export function anthropicResponse(modelId: string, a: Answer): object {
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: a.text }],
    stop_reason: anthropicStopReason(a.finish),
    usage: { input_tokens: a.inputTokens, output_tokens: a.outputTokens },
  };
}

export function openaiFailure(e: unknown): Failure {
  const { status, type, message } = describeError(e);
  return { status, body: { error: { message, type, param: null, code: null } } };
}

export function anthropicFailure(e: unknown): Failure {
  const { status, type, message } = describeError(e);
  return { status, body: { type: "error", error: { type, message } } };
}

/** Writes a failure in the dialect's envelope, with the status it picked. */
export function sendFailure(c: Context, fail: (e: unknown) => Failure, e: unknown) {
  const { status, body } = fail(e);
  return c.json(body, status as ContentfulStatusCode);
}
