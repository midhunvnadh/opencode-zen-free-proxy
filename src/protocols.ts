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
  toolCalls?: ToolCall[];
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
function toolExchange(tools: any, messages: any[], toolChoice?: any): Tools {
  let declared: ToolSpec[] = (Array.isArray(tools) ? tools : [])
    .map((t: any) => ({
      name: functionName(t),
      description: t?.function?.description ?? t?.description,
      parameters: t?.function?.parameters ?? t?.input_schema,
    }))
    .filter((t) => t.name);

  if (toolChoice === "none" || toolChoice?.type === "none") {
    declared = [];
  } else if (typeof toolChoice === "object" && toolChoice !== null) {
    const forced = toolChoice.function?.name || toolChoice.name;
    if (forced && typeof forced === "string") {
      declared = declared.filter((t) => t.name === forced);
    }
  }

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
export function toPrompt(messages: any[], tools?: any, toolChoice?: any): Prompt {
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
  return { system, transcript: turns.join("\n\n"), lastUserText, tools: toolExchange(tools, messages, toolChoice) };
}

/** The caller's functions, described for the model. opencode's tool list cannot be
 *  replaced, so this is the only way a client tool reaches the model at all — and it is
 *  why a blocked tool is refused rather than run: the model has to use these instead. */
export function toolInstructions(declared: ToolSpec[], toolChoice?: any): string {
  if (!declared.length) return "";
  const list = declared
    .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}${t.parameters ? ` arguments schema: ${JSON.stringify(t.parameters)}` : ""}`)
    .join("\n");

  let requirement = "";
  if (toolChoice === "required" || toolChoice?.type === "any") {
    requirement = "\n\nYou MUST call one of the caller's functions this turn.";
  } else if (typeof toolChoice === "object" && toolChoice !== null) {
    const forced = toolChoice.function?.name || toolChoice.name;
    if (forced && typeof forced === "string") {
      requirement = `\n\nYou MUST call the tool "${forced}" this turn.`;
    }
  }

  return `You can call functions on the caller's machine, and none of your own tools are available. When you need one, emit exactly this block (JSON on one line, no text after the closing tag):

<tool_call>
{"name": "<the function>", "arguments": <its arguments>}
</tool_call>

[client tools]
${list}${requirement}`;
}

/** The model announces a call in a fenced block, XML block, or bracket block. */
const FENCE = /```tool_call\s*([\s\S]*?)```/;
const OPEN_FENCE = /```tool_call[\s\S]*$/;
const XML_FENCE = /<tool_call>\s*([\s\S]*?)<\/tool_call>/;
const OPEN_XML = /<tool_call>[\s\S]*$/;
const BRACKET_FENCE = /\[tool_call\]\s*([\s\S]*?)\[\/tool_call\]/;
const OPEN_BRACKET = /\[tool_call\][\s\S]*$/;

export const TOOL_MARKERS = [
  { open: "<tool_call>", close: "</tool_call>" },
  { open: "```tool_call", close: "```" },
  { open: "[tool_call]", close: "[/tool_call]" },
] as const;

export function findNextOpen(text: string, start: number): { idx: number; open: string; close: string } | null {
  let best: { idx: number; open: string; close: string } | null = null;
  for (const m of TOOL_MARKERS) {
    const j = text.indexOf(m.open, start);
    if (j >= 0 && (best === null || j < best.idx)) {
      best = { idx: j, open: m.open, close: m.close };
    }
  }
  return best;
}

export function partialOpenHold(rest: string): number {
  let hold = 0;
  for (const m of TOOL_MARKERS) {
    const maxH = Math.min(m.open.length - 1, rest.length);
    for (let k = maxH; k > 0; k--) {
      if (m.open.startsWith(rest.slice(rest.length - k))) {
        hold = Math.max(hold, k);
        break;
      }
    }
  }
  return hold;
}

export function parseToolBody(body: string): { name: string; arguments: Record<string, unknown> } | null {
  if (!body || !body.trim()) return null;
  let cleaned = body.trim();
  // Strip inner markdown fences if model wrapped JSON in code fences inside the tool block
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const sanitize = (s: string) => s.replace(/,\s*([\}\]])/g, "$1").replace(/,\s*$/, "").trim();

  let said: any;
  try {
    said = JSON.parse(cleaned);
  } catch {
    try {
      said = JSON.parse(sanitize(cleaned));
    } catch {
      return null;
    }
  }

  if (typeof said !== "object" || said === null || Array.isArray(said)) {
    return null;
  }

  const name = said.name || said.function?.name;
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }

  const rawArgs = said.arguments ?? said.parameters ?? said.args;
  let parsedArgs: Record<string, unknown> = {};

  if (typeof rawArgs === "string") {
    const s = rawArgs.trim();
    if (s) {
      try {
        const decoded = JSON.parse(s);
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
          return null;
        }
        parsedArgs = decoded as Record<string, unknown>;
      } catch {
        try {
          const decoded = JSON.parse(sanitize(s));
          if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
            return null;
          }
          parsedArgs = decoded as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    if (Array.isArray(rawArgs)) {
      return null;
    }
    parsedArgs = rawArgs as Record<string, unknown>;
  } else if (rawArgs === undefined || rawArgs === null) {
    parsedArgs = {};
  } else {
    return null;
  }

  return { name: name.trim(), arguments: parsedArgs };
}

export function streamingView(text: string, declared: readonly string[] = []): { clean: string; calls: ToolCall[] } {
  if (!text) return { clean: "", calls: [] };
  const calls: ToolCall[] = [];
  const parts: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const nxt = findNextOpen(text, i);
    if (nxt === null) {
      const rest = text.slice(i);
      const hold = partialOpenHold(rest);
      parts.push(hold > 0 ? rest.slice(0, rest.length - hold) : rest);
      break;
    }
    const { idx: j, open, close } = nxt;
    parts.push(text.slice(i, j));
    const k = text.indexOf(close, j + open.length);
    if (k < 0) {
      break;
    }
    const body = text.slice(j + open.length, k);
    const parsed = parseToolBody(body);
    if (parsed && declared.includes(parsed.name)) {
      calls.push({ id: rid("call_"), name: parsed.name, arguments: parsed.arguments });
    }
    i = k + close.length;
  }
  return { clean: parts.join(""), calls };
}

export function extractToolCalls(text: string, declared: readonly string[] = []): { clean: string; calls: ToolCall[] } {
  if (!text) return { clean: "", calls: [] };
  const calls: ToolCall[] = [];
  const parts: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const nxt = findNextOpen(text, i);
    if (nxt === null) {
      parts.push(text.slice(i));
      break;
    }
    const { idx: j, open, close } = nxt;
    parts.push(text.slice(i, j));
    const k = text.indexOf(close, j + open.length);
    if (k < 0) {
      break;
    }
    const body = text.slice(j + open.length, k);
    const parsed = parseToolBody(body);
    if (parsed && declared.includes(parsed.name)) {
      calls.push({ id: rid("call_"), name: parsed.name, arguments: parsed.arguments });
    }
    i = k + close.length;
  }
  return { clean: stripFences(parts.join("")), calls };
}

/** What a fenced or XML block asks for, or null when the text holds none or it cannot be read.
 *  Whether the client offered the function is not decided here. */
export function announced(text: string): { name: string; arguments: Record<string, unknown> } | null {
  let i = 0;
  while (i < text.length) {
    const nxt = findNextOpen(text, i);
    if (!nxt) break;
    const k = text.indexOf(nxt.close, nxt.idx + nxt.open.length);
    if (k < 0) break;
    const body = text.slice(nxt.idx + nxt.open.length, k);
    const parsed = parseToolBody(body);
    if (parsed) return parsed;
    i = k + nxt.close.length;
  }
  return null;
}

/** The block is the proxy's own convention, so it is never part of the answer — not when
 *  it holds a call, not when the model copied the template back, and not when a truncated
 *  turn left the opener unclosed. Anything the model wrote around it is still its answer. */
export const stripFences = (text: string) =>
  text
    .replace(new RegExp(XML_FENCE.source, "g"), "")
    .replace(OPEN_XML, "")
    .replace(new RegExp(FENCE.source, "g"), "")
    .replace(OPEN_FENCE, "")
    .replace(new RegExp(BRACKET_FENCE.source, "g"), "")
    .replace(OPEN_BRACKET, "")
    .trim();

/** The function a tool block asks for, as the model wrote it — whether or not the client
 *  ever offered it. Deciding what may be handed over is the caller's list to make. */
export const announcedName = (text: string) => announced(text)?.name ?? null;

/** Lifts the call out of the answer, when the client declared one. A block naming anything
 *  else is not the caller's to run, so it is dropped rather than handed over — which is
 *  what keeps a function the client never offered from reaching its own machine. */
export function parseToolCall(text: string, declared: readonly string[]): { call?: ToolCall; text: string } {
  const { clean, calls } = extractToolCalls(text, declared);
  return { text: clean, ...(calls[0] ? { call: calls[0] } : {}) };
}

/** Feed raw deltas; emit only client-safe content; collect finished calls. */
export class ToolCallStreamParser {
  private raw = "";
  private emitted = 0;
  private pending: ToolCall[] = [];
  private recognized = 0;
  private emittedCalls = 0;
  public readonly declared: readonly string[];

  constructor(declared: readonly string[] = []) {
    this.declared = declared;
  }

  feed(delta: string): string {
    if (!delta) return "";
    this.raw += delta;
    const { clean, calls } = streamingView(this.raw, this.declared);
    if (calls.length > this.recognized) {
      this.pending.push(...calls.slice(this.recognized));
      this.recognized = calls.length;
    }
    if (clean.length <= this.emitted) return "";
    const out = clean.slice(this.emitted);
    this.emitted = clean.length;
    return out;
  }

  drainCalls(): ToolCall[] {
    const out = this.pending;
    this.pending = [];
    this.emittedCalls += out.length;
    return out;
  }

  finish(finalText?: string): { text: string; calls: ToolCall[] } {
    if (finalText !== undefined) {
      this.raw = finalText;
    }
    const { clean, calls } = extractToolCalls(this.raw, this.declared);
    let out = "";
    if (clean.length > this.emitted) {
      out = clean.slice(this.emitted);
      this.emitted = clean.length;
    }
    const rest = calls.slice(this.emittedCalls);
    this.recognized = calls.length;
    this.pending = [];
    this.emittedCalls = calls.length;
    return { text: out, calls: rest };
  }
}

/** Formats one tool result with unambiguous result tags, escaping literal </result>. */
export function formatToolResult(name: string, id: string, content: string): string {
  const safe = (content ?? "").replace(/<\/result>/g, "<\\/result>");
  const label = name ? `[tool result: ${name}]` : "[tool result]";
  const callPart = id ? ` (call ${id})` : "";
  return `${label}${callPart}\n<result>\n${safe}\n</result>`;
}

/** What the client executed, as prompt text: the model asked for these tools, they were
 *  not run here, and this is what came back from the caller. */
export function toolResultPrompt(results: ToolResult[]): string {
  if (!results.length) return "";
  const blocks = results.map(
    (r) =>
      `Tool \`${r.name || "unnamed"}\` (${r.id}) was not available to run here. The caller ran it instead and returned:\n\n<result>\n${(r.content ?? "").replace(/<\/result>/g, "<\\/result>")}\n</result>`
  );
  return `${blocks.join("\n\n")}\n\nAnswer the request above using these results.`;
}

/** Formats assistant tool_calls so the model remembers what it called. */
export function renderToolCalls(toolCalls: any[]): string {
  const rendered: string[] = [];
  for (const tc of toolCalls ?? []) {
    if (!tc || typeof tc !== "object") continue;
    const fn = tc.function ?? {};
    const name = fn.name || tc.name || "unknown-tool";
    let args = fn.arguments ?? tc.arguments ?? "";
    if (typeof args !== "string") {
      try {
        args = JSON.stringify(args);
      } catch {
        args = String(args);
      }
    }
    let line = `- ${name}(${args})`;
    if (tc.id) line += ` (call ${tc.id})`;
    rendered.push(line);
  }
  if (!rendered.length) return "";
  return `[assistant tool calls]\n${rendered.join("\n")}`;
}

/** Formats a tail slice for delta continuation turns without duplicating
 *  state already stored in the backend session. */
export function flattenDelta(
  tailMessages: any[],
  entry: { lastReply?: string; lastReasoning?: string } | null
): string {
  const lastReply = (entry?.lastReply ?? "").trim();
  const lastReasoning = (entry?.lastReasoning ?? "").trim();
  const blocks: string[] = [];

  for (const m of tailMessages ?? []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role || "user";
    const text = extractText(m.content);

    if (role === "system" || role === "developer") {
      if (text) blocks.push(`[system]\n${text}`);
    } else if (role === "assistant") {
      const reasoning = (typeof m.reasoning_content === "string" ? m.reasoning_content : "").trim();
      const calls = renderToolCalls(Array.isArray(m.tool_calls) ? m.tool_calls : []);
      const keepReasoning = Boolean(reasoning && reasoning !== lastReasoning);
      const keepText = Boolean(text && text.trim() !== lastReply);

      if (keepReasoning) {
        blocks.push(`[assistant reasoning]\n${reasoning}\n[/assistant reasoning]`);
      }
      if (keepText && calls) {
        blocks.push(`[assistant]\n${text}\n${calls}`);
      } else if (keepText) {
        blocks.push(`[assistant]\n${text}`);
      } else if (calls) {
        blocks.push(calls);
      }
    } else if (role === "tool") {
      const name = m.name || "";
      const tcid = m.tool_call_id || "";
      if (text) {
        blocks.push(formatToolResult(name, tcid, text));
      }
    } else {
      if (text) blocks.push(`User: ${text}`);
    }
  }

  return blocks.join("\n\n").trim();
}

export function anthropicPrompt(body: any): Prompt {
  // Anthropic keeps the system prompt next to the messages, not inside them.
  return { ...toPrompt(body.messages, body.tools, body.tool_choice), system: extractText(body.system) };
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

/** The assistant message as an answer, with tool calls lifted out of the text when the
 *  model announced ones the client had declared. */
export function extractAnswer(message: any, declared: readonly string[]): Answer {
  const answer = extractMessage(message);
  const { clean, calls } = extractToolCalls(answer.text, declared);
  return {
    ...answer,
    text: clean,
    ...(calls[0] ? { toolCall: calls[0], toolCalls: calls } : {}),
  };
}

/** A turn that ended by handing a tool over stops for its own reason in both dialects. */
export const openaiFinish = (a: Answer, sentTool = false) =>
  sentTool || a.toolCall || (a.toolCalls && a.toolCalls.length > 0) ? "tool_calls" : a.finish === "length" ? "length" : "stop";
export const anthropicStopReason = (a: Answer, sentTool = false) =>
  sentTool || a.toolCall || (a.toolCalls && a.toolCalls.length > 0) ? "tool_use" : a.finish === "length" ? "max_tokens" : "end_turn";
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
  const calls = a.toolCalls && a.toolCalls.length ? a.toolCalls : a.toolCall ? [a.toolCall] : [];
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
          ...(calls.length ? { tool_calls: calls.map(openaiToolCall) } : {}),
        },
        finish_reason: openaiFinish(a),
      },
    ],
    usage: openaiUsage(a),
  };
}

export function anthropicResponse(modelId: string, a: Answer): object {
  const calls = a.toolCalls && a.toolCalls.length ? a.toolCalls : a.toolCall ? [a.toolCall] : [];
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [
      ...(a.text ? [{ type: "text", text: a.text }] : []),
      ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })),
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
