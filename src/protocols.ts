import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError, nowSeconds, rid } from "./lib.ts";

/** The two wire formats this proxy speaks, as plain data: request bodies and backend
 *  answers in, provider responses and error envelopes out. */

/** A tool the client is expected to run. `id` is the backend's call id, which travels
 *  out as `tool_call_id` and comes back with the result. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One executed tool, as the client sends it back. */
export interface ToolResult {
  id: string;
  name: string;
  content: string;
}

/** A function the client offered, in the shape the model needs to call it. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: any;
}

/** The tools a request offers and the results it is returning. */
export interface Tools {
  /** What the client declared it can run. Anything else the model asks for is not run
   *  here — see [tool calling](tool-calling.md). */
  declared: ToolSpec[];
  results: ToolResult[];
}

export interface Answer {
  text: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  finish?: string;
  /** Set when the turn ended by handing a tool to the client instead of answering. */
  toolCall?: ToolCall;
}

export interface Prompt {
  system: string;
  transcript: string;
  lastUserText: string;
  tools: Tools;
}

export interface Failure {
  status: number;
  body: object;
}

/** Message content is plain text. A tool result is not included: it is what the client
 *  ran, not words anyone wrote, so it belongs to the tool exchange instead. */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** A function's name, whichever way the caller wrote it: OpenAI nests it under
 *  `function`, Anthropic puts it at the top, and either may pass the function itself. */
const functionName = (t: any) =>
  (typeof t === "function" ? t.name : t?.function?.name ?? t?.name);

/** Both providers say the same thing in different shapes: OpenAI declares functions in
 *  `tools[]` and returns their results as `role: "tool"` turns keyed by `tool_call_id`;
 *  Anthropic calls them `input_schema` and `tool_use_id`, and puts the result in a
 *  `tool_result` block. Names are resolved from the call that asked for them, so the
 *  result text can say which tool it came from. */
function toolExchange(tools: any, messages: any[]): Tools {
  const declared: ToolSpec[] = (Array.isArray(tools) ? tools : [])
    .map((t: any) => ({
      name: functionName(t),
      description: t?.function?.description ?? t?.description,
      parameters: t?.function?.parameters ?? t?.input_schema,
    }))
    .filter((t) => t.name);
  const called = new Map<string, string>();
  const results: ToolResult[] = [];
  const result = (id: any, content: any) => {
    if (id) results.push({ id, name: called.get(id) ?? "", content: extractText(content) });
  };
  for (const m of messages ?? []) {
    for (const t of Array.isArray(m?.tool_calls) ? m.tool_calls : [])
      if (t?.id) called.set(t.id, functionName(t.function) ?? "");
    for (const p of Array.isArray(m?.content) ? m.content : [])
      if (p?.type === "tool_use") called.set(p.id, p.name);
    // The result is its own turn in OpenAI and a block in an Anthropic user turn. Either
    // way it is not something the model said, so it stays out of the transcript.
    if (m?.role === "tool") result(m.tool_call_id, m.content);
    for (const p of Array.isArray(m?.content) ? m.content : [])
      if (p?.type === "tool_result") result(p.tool_use_id, p.content);
  }
  return { declared, results };
}

/** Flattens a conversation into one prompt: the system instructions, the whole
 *  transcript, the last user turn on its own, and the tool exchange. */
export function toPrompt(messages: any[], tools?: any): Prompt {
  let system = "";
  let lastResult = -1;
  const turns: string[] = [];
  const asked: { at: number; text: string }[] = [];
  (messages ?? []).forEach((m, at) => {
    // A result turn carries no words the model wrote, so it is left to the tool exchange
    // below rather than counted as something the user said.
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else if (m.role !== "tool") {
      const text = extractText(m.content);
      if (text) turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${text}`);
      if (m.role !== "assistant") asked.push({ at, text });
    }
    if (m.role === "tool" || (Array.isArray(m?.content) ? m.content : []).some((p: any) => p?.type === "tool_result")) {
      lastResult = at;
    }
  });
  // A question asked before the result has already been asked: the result is its answer,
  // so putting it in the prompt again would send the model round the loop again.
  const lastUserText = (lastResult < 0 ? asked : asked.filter((t) => t.at > lastResult)).at(-1)?.text ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText, tools: toolExchange(tools, messages) };
}

/** The caller's functions, described for the model. opencode's tool list cannot be
 *  replaced, so this is the only way a client tool reaches the model at all — and it is
 *  why a blocked tool is refused rather than run: the model has to use these instead. */
export function toolInstructions(declared: ToolSpec[]): string {
  if (!declared.length) return "";
  const list = declared
    .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}${t.parameters ? ` arguments schema: ${JSON.stringify(t.parameters)}` : ""}`)
    .join("\n");
  return `You can call functions on the caller's machine, and none of your own tools are available. When you need one, reply with a single fenced block and nothing after it:

\`\`\`tool_call
{"name": "<the function>", "arguments": {<its arguments>}}
\`\`\`

The caller's functions:
${list}`;
}

/** The model announces a call in a fenced block, so the block is lifted out of the answer
 *  and the call handed to the client. Anything the model wrote around it is still its
 *  answer. A block that is not a call is left where it is. */
export function parseToolCall(text: string): { call?: ToolCall; text: string } {
  const match = text.match(/```tool_call\s*([\s\S]*?)```/);
  if (!match) return { text };
  try {
    const { name, arguments: args } = JSON.parse(match[1]);
    if (!name) return { text };
    return { call: { id: rid("call_"), name, arguments: args ?? {} }, text: text.replace(match[0], "").trim() };
  } catch {
    return { text };
  }
}

/** What the client executed, as prompt text: the model asked for these tools, they were
 *  not run here, and this is what came back from the caller. */
export function toolResultPrompt(results: ToolResult[]): string {
  if (!results.length) return "";
  const blocks = results.map(
    (r) => `Tool \`${r.name || "unnamed"}\` (${r.id}) was not available to run here. The caller ran it instead and returned:\n\n${r.content}`
  );
  return `${blocks.join("\n\n")}\n\nAnswer the request above using these results.`;
}

export function anthropicPrompt(body: any): Prompt {
  // Anthropic keeps the system prompt next to the messages, not inside them.
  return { ...toPrompt(body.messages, body.tools), system: extractText(body.system) };
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

/** The assistant message as an answer, with a tool call lifted out of the text when the
 *  model announced one. */
export function extractAnswer(message: any): Answer {
  const answer = extractMessage(message);
  const { call, text } = parseToolCall(answer.text);
  return call ? { ...answer, text, toolCall: call } : answer;
}

/** A turn that ended by handing a tool over stops for its own reason in both dialects. */
export const openaiFinish = (a: Answer) =>
  a.toolCall ? "tool_calls" : a.finish === "length" ? "length" : "stop";
export const anthropicStopReason = (a: Answer) =>
  a.toolCall ? "tool_use" : a.finish === "length" ? "max_tokens" : "end_turn";
export const openaiUsage = (a: Answer) => ({
  prompt_tokens: a.inputTokens,
  completion_tokens: a.outputTokens,
  total_tokens: a.inputTokens + a.outputTokens,
});

/** Arguments cross the wire as a JSON string, the way both providers expect them. */
export const toolArguments = (call: ToolCall) => JSON.stringify(call.arguments);

export const openaiToolCall = (call: ToolCall) => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: toolArguments(call) },
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
        message: {
          role: "assistant",
          // A turn that is only a tool call has no text, and null is how both providers
          // spell that; clients read content before they read tool_calls.
          content: a.text || null,
          ...(a.reasoning ? { reasoning_content: a.reasoning } : {}),
          ...(a.toolCall ? { tool_calls: [openaiToolCall(a.toolCall)] } : {}),
        },
        finish_reason: openaiFinish(a),
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
    content: [
      ...(a.text ? [{ type: "text", text: a.text }] : []),
      ...(a.toolCall ? [{ type: "tool_use", id: a.toolCall.id, name: a.toolCall.name, input: a.toolCall.arguments }] : []),
    ],
    stop_reason: anthropicStopReason(a),
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
