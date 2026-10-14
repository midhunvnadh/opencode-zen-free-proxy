import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib.ts";
import {
  anthropicFailure,
  anthropicPrompt,
  anthropicResponse,
  extractMessage,
  openaiFailure,
  openaiResponse,
  toPrompt,
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

  it("flattens array content and tool results into text", () => {
    const p = toPrompt([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: {} }] },
    ]);
    expect(p.lastUserText).toBe("look");

    const withTool = toPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "result:" },
          { type: "tool_result", content: "plain text result" },
        ],
      },
    ]);
    expect(withTool.lastUserText).toBe("result:\nplain text result");

    const nested = toPrompt([
      {
        role: "user",
        content: [{ type: "tool_result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
      },
    ]);
    expect(nested.lastUserText).toBe("a\nb");
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
