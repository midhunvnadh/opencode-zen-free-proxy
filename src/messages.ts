// @ts-nocheck
import { rid } from "./lib/id.ts";
import { nowSeconds } from "./lib/time.ts";

export { rid };

export function extractMessage(message: any) {
  const parts = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message?.parts)
      ? message.parts
      : [];
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

export function mapFinish(finish: any) {
  return finish === "length" ? "length" : "stop";
}

export function anthropicStopReason(finish: any) {
  return finish === "length" ? "max_tokens" : "end_turn";
}

export function openaiResponse(modelId: string, r: any) {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: nowSeconds(),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
        },
        finish_reason: mapFinish(r.finish),
      },
    ],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  };
}

export function anthropicResponse(modelId: string, r: any) {
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: r.text }],
    stop_reason: anthropicStopReason(r.finish),
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}
