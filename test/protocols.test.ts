import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib.ts";
import {
  anthropicFailure,
  anthropicPrompt,
  anthropicResponse,
  extractAnswer,
  extractMessage,
  openaiFailure,
  openaiResponse,
  parseToolCall,
  toPrompt,
  toolInstructions,
  toolResultPrompt,
} from "../src/protocols.ts";

const answer = {
  text: "hi",
  reasoning: "because",
  inputTokens: 7,
  outputTokens: 3,
  finish: "stop",
};

describe("toPrompt", () => {
  it("separates system instructions and finds the last user turn", () => {
    const p = toPrompt([
      { role: "system", content: "Be brief." },
      { role: "user", content: "first" },
      { role: "assistant", content: "sure" },
      { role: "user", content: "second" },
    ]);
    expect(p.system).toBe("Be brief.");
    expect(p.transcript).toBe("User: first\n\nAssistant: sure\n\nUser: second");
    expect(p.lastUserText).toBe("second");
  });

  it("keeps an assistant turn after the last user turn out of lastUserText", () => {
    const p = toPrompt([
      { role: "user", content: "only" },
      { role: "assistant", content: "trailing" },
    ]);
    expect(p.lastUserText).toBe("only");
  });

  it("joins several system messages with a blank line", () => {
    expect(toPrompt([{ role: "system", content: "a" }, { role: "system", content: "b" }]).system).toBe("a\n\nb");
  });

  it("has no last user turn when the client sent none", () => {
    expect(toPrompt([{ role: "system", content: "a" }]).lastUserText).toBe("");
    expect(toPrompt([]).lastUserText).toBe("");
    expect(toPrompt(undefined as unknown as any[]).lastUserText).toBe("");
  });

  it("flattens array content into text and leaves other blocks out", () => {
    const p = toPrompt([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: {} }] },
    ]);
    expect(p.lastUserText).toBe("look");

    const nested = toPrompt([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
      },
    ]);
    // The result is the tool exchange, not something the user said.
    expect(nested.lastUserText).toBe("");
    expect(nested.tools.results).toEqual([{ id: "call_1", name: "", content: "a\nb" }]);
  });
});

describe("the tool exchange", () => {
  it("reads the functions out of an OpenAI tools array, schema and all", () => {
    const p = toPrompt([{ role: "user", content: "hi" }], [
      { type: "function", function: { name: "get_weather", description: "current weather", parameters: { type: "object" } } },
      { type: "function", function: { name: "now" } },
    ]);
    expect(p.tools.declared).toEqual([
      { name: "get_weather", description: "current weather", parameters: { type: "object" } },
      { name: "now", description: undefined, parameters: undefined },
    ]);
    expect(p.tools.results).toEqual([]);
  });

  it("reads the functions out of an Anthropic tools array", () => {
    const p = anthropicPrompt({
      tools: [{ name: "get_weather", description: "current weather", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(p.tools.declared[0]).toEqual({ name: "get_weather", description: "current weather", parameters: { type: "object" } });
  });

  it("drops a tool entry with no name", () => {
    expect(toPrompt([], [{ type: "function" }]).tools.declared).toEqual([]);
  });

  it("collects OpenAI tool turns and names them after the call that asked", () => {
    const p = toPrompt(
      [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_a", content: "18C and raining" },
      ],
      [{ type: "function", function: { name: "get_weather" } }]
    );
    expect(p.tools.results).toEqual([{ id: "call_a", name: "get_weather", content: "18C and raining" }]);
    // The result turn is not something the user wrote, so it stays out of the transcript.
    expect(p.transcript).toBe("User: weather in Paris?");
  });

  it("collects Anthropic tool_result blocks", () => {
    const p = toPrompt(
      [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C" }] },
      ],
      [{ name: "get_weather", input_schema: { type: "object" } }]
    );
    expect(p.tools.results).toEqual([{ id: "toolu_1", name: "get_weather", content: "18C" }]);
  });

  it("has no tools when the request offers none", () => {
    expect(toPrompt([{ role: "user", content: "hi" }]).tools).toEqual({ declared: [], results: [] });
    expect(toPrompt([{ role: "user", content: "hi" }], undefined).tools.declared).toEqual([]);
  });

  it("does not ask again a question the result already answers", () => {
    const p = toPrompt([
      { role: "user", content: "weather in Paris?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "get_weather" } }] },
      { role: "tool", tool_call_id: "call_a", content: "18C" },
    ]);
    // The result is the request now; the question would send the model round again.
    expect(p.lastUserText).toBe("");
    expect(p.transcript).toBe("User: weather in Paris?");
  });

  it("asks a question that came after the result", () => {
    const p = toPrompt([
      { role: "user", content: "weather in Paris?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "get_weather" } }] },
      { role: "tool", tool_call_id: "call_a", content: "18C" },
      { role: "user", content: "and in Rome?" },
    ]);
    expect(p.lastUserText).toBe("and in Rome?");
  });

  it("writes the results as prompt text naming the tool and the call", () => {
    const text = toolResultPrompt([{ id: "call_a", name: "get_weather", content: "18C" }]);
    expect(text).toContain("`get_weather` (call_a)");
    expect(text).toContain("18C");
    expect(toolResultPrompt([])).toBe("");
  });
});

describe("telling the model about the caller's functions", () => {
  const weather = { name: "get_weather", description: "current weather", parameters: { type: "object", properties: { city: { type: "string" } } } };

  it("describes each function and the block to call it with", () => {
    const text = toolInstructions([weather]);
    expect(text).toContain("get_weather: current weather");
    expect(text).toContain('{"type":"object","properties":{"city":{"type":"string"}}}');
    expect(text).toContain("```tool_call");
    expect(text).toContain("none of your own tools are available");
  });

  it("says nothing when there are no functions", () => {
    expect(toolInstructions([])).toBe("");
  });
});

describe("lifting a tool call out of the answer", () => {
  it("reads a fenced call and keeps the prose around it", () => {
    const { call, text } = parseToolCall('Let me look.\n```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```');
    expect(call).toMatchObject({ name: "get_weather", arguments: { city: "Paris" } });
    expect(call?.id).toMatch(/^call_/);
    expect(text).toBe("Let me look.");
  });

  it("defaults the arguments to an empty object", () => {
    expect(parseToolCall('```tool_call\n{"name": "now"}\n```').call).toMatchObject({ name: "now", arguments: {} });
  });

  it("leaves an answer that holds no call alone", () => {
    expect(parseToolCall("just prose").call).toBeUndefined();
    expect(parseToolCall("just prose").text).toBe("just prose");
  });

  it("leaves a malformed block alone rather than failing the request", () => {
    const raw = "```tool_call\nnot json at all\n```";
    expect(parseToolCall(raw).call).toBeUndefined();
    expect(parseToolCall(raw).text).toBe(raw);
  });

  it("reaches the answer through the message the backend returned", () => {
    const answer = extractAnswer({
      content: [{ type: "text", text: '```tool_call\n{"name": "now", "arguments": {}}\n```' }],
      tokens: { input: 3, output: 1 },
    });
    expect(answer.toolCall).toMatchObject({ name: "now" });
    // The markup is the proxy's, not the client's, so it is not part of the answer.
    expect(answer.text).toBe("");
  });
});

describe("anthropicPrompt", () => {
  it("takes the system prompt from the body, not from the messages", () => {
    const p = anthropicPrompt({
      system: "Be brief.",
      messages: [
        { role: "system", content: "ignored" },
        { role: "user", content: "hello" },
      ],
    });
    expect(p.system).toBe("Be brief.");
    expect(p.lastUserText).toBe("hello");
  });

  it("accepts a system prompt given as blocks", () => {
    expect(anthropicPrompt({ system: [{ type: "text", text: "blocks" }], messages: [] }).system).toBe("blocks");
  });
});

describe("extractMessage", () => {
  it("splits text from reasoning and reads usage", () => {
    const a = extractMessage({
      content: [
        { type: "reasoning", text: "think " },
        { type: "text", text: "answer" },
      ],
      tokens: { input: 11, output: 5 },
      finish: "length",
    });
    expect(a).toEqual({ text: "answer", reasoning: "think ", inputTokens: 11, outputTokens: 5, finish: "length" });
  });

  it("accepts the parts/info shape as well as content", () => {
    const a = extractMessage({ parts: [{ type: "text", text: "x" }], info: { tokens: { input: 1, output: 2 } } });
    expect(a.text).toBe("x");
    expect(a.inputTokens).toBe(1);
    expect(a.outputTokens).toBe(2);
  });

  it("degrades to empty rather than throwing on a malformed message", () => {
    expect(extractMessage(undefined).text).toBe("");
    expect(extractMessage({ content: "not an array" }).text).toBe("");
    expect(extractMessage({}).inputTokens).toBe(0);
  });

  
});

describe("responses", () => {
  it("shapes an OpenAI completion", () => {
    const r = openaiResponse("big-pickle", answer) as any;
    expect(r.object).toBe("chat.completion");
    expect(r.model).toBe("big-pickle");
    expect(r.id).toMatch(/^chatcmpl-/);
    expect(r.choices[0].message).toMatchObject({ role: "assistant", content: "hi", reasoning_content: "because" });
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it("omits reasoning_content when there is no reasoning", () => {
    const r = openaiResponse("m", { ...answer, reasoning: "" }) as any;
    expect("reasoning_content" in r.choices[0].message).toBe(false);
  });

  it("maps a truncated answer onto each dialect's vocabulary", () => {
    expect((openaiResponse("m", { ...answer, finish: "length" }) as any).choices[0].finish_reason).toBe("length");
    expect((anthropicResponse("m", { ...answer, finish: "length" }) as any).stop_reason).toBe("max_tokens");
    expect((anthropicResponse("m", answer) as any).stop_reason).toBe("end_turn");
  });

  it("shapes an OpenAI tool call", () => {
    const r = openaiResponse("m", { ...answer, text: "", reasoning: "", toolCall: { id: "call_a", name: "get_weather", arguments: { city: "Paris" } } }) as any;
    expect(r.choices[0].finish_reason).toBe("tool_calls");
    expect(r.choices[0].message.content).toBeNull();
    expect(r.choices[0].message.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
  });

  it("keeps text that arrived before the tool call", () => {
    const r = openaiResponse("m", { ...answer, toolCall: { id: "call_a", name: "t", arguments: {} } }) as any;
    expect(r.choices[0].message.content).toBe("hi");
    expect(r.choices[0].message.tool_calls[0].function.arguments).toBe("{}");
  });

  it("shapes an Anthropic tool call as a tool_use block", () => {
    const r = anthropicResponse("m", { ...answer, text: "", reasoning: "", toolCall: { id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } } }) as any;
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }]);
  });

  it("keeps a text block alongside an Anthropic tool call", () => {
    const r = anthropicResponse("m", { ...answer, toolCall: { id: "toolu_1", name: "t", arguments: {} } }) as any;
    expect(r.content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("shapes an Anthropic message", () => {
    const r = anthropicResponse("big-pickle", answer) as any;
    expect(r.type).toBe("message");
    expect(r.id).toMatch(/^msg_/);
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });
});

describe("failures", () => {
  it("keeps an OpenAI-shaped envelope", () => {
    const f = openaiFailure(new HttpError(400, "bad model", "invalid_request_error"));
    expect(f.status).toBe(400);
    expect(f.body).toEqual({
      error: { message: "bad model", type: "invalid_request_error", param: null, code: null },
    });
  });

  it("keeps an Anthropic-shaped envelope", () => {
    const f = anthropicFailure(new HttpError(429, "slow down"));
    expect(f.status).toBe(429);
    expect(f.body).toEqual({ type: "error", error: { type: "upstream_error", message: "slow down" } });
  });

  it("reports an unexpected failure as a bad gateway", () => {
    expect(openaiFailure(new Error("connection reset")).status).toBe(502);
  });
});
