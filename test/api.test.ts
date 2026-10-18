import { beforeEach, describe, expect, it, vi } from "vitest";

// The fake backend replaces the only module that talks to a real `opencode serve`.
// Everything else - routing, middleware, dialects, sinks, the relay - is the real
// implementation, so these tests cover the proxy end to end without a live model.
const backend = vi.hoisted(() => ({
  models: ["big-pickle", "small-pickle"] as string[],
  deltas: [] as { kind: string; text: string }[],
  calls: [] as any[],
  fail: null as null | { status: number; message: string; type?: string },
  answer: { content: [], tokens: {}, finish: "stop" } as {
    content: { type: string; text?: string }[];
    tokens: { input?: number; output?: number };
    finish?: string;
  },
}));

vi.mock("../src/opencode.ts", () => ({
  ocBase: () => "http://127.0.0.1:65000",
  modelCount: () => backend.models.length,
  listModels: async () => backend.models,
  askModel: async (req: any) => {
    backend.calls.push(req);
    // A slow answer is what lets the relay take the "already streaming" branch,
    // so a configured failure lands after the deltas rather than before them.
    if (backend.deltas.length) await new Promise((r) => setTimeout(r, 20));
    if (backend.fail) {
      const { HttpError } = await import("../src/lib.ts");
      throw new HttpError(backend.fail.status, backend.fail.message, backend.fail.type);
    }
    return backend.answer;
  },
  connectEvents: (watch: any) => {
    const timer = setTimeout(() => {
      for (const d of backend.deltas) watch.sink.delta(d.kind, d.text);
    }, 0);
    return { close: () => clearTimeout(timer) };
  },
}));

const { createApp } = await import("../src/app.ts");
const app = createApp();

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ask = (extra: Record<string, unknown> = {}) => ({
  model: "big-pickle",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

const json = async (res: Response) => JSON.parse(await res.text());

/** Reads an SSE body once, returning the raw text and its frames in order. The
 *  OpenAI `[DONE]` sentinel is not JSON, so a non-JSON payload stays a string. */
const sse = async (res: Response) => {
  const raw = await res.text();
  const frames: { event: string | undefined; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    const frame: { event: string | undefined; data: any } = { event: undefined, data: undefined };
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) frame.event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          frame.data = JSON.parse(payload);
        } catch {
          frame.data = payload;
        }
      }
    }
    frames.push(frame);
  }
  return { raw, frames };
};

beforeEach(() => {
  backend.models = ["big-pickle", "small-pickle"];
  backend.deltas = [];
  backend.calls = [];
  backend.fail = null;
  backend.answer = { content: [{ type: "text", text: "hi there" }], tokens: { input: 4, output: 2 }, finish: "stop" };
});

describe("GET /health and models", () => {
  it("reports the backend and the model count", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      status: "ok",
      opencode: "http://127.0.0.1:65000",
      models: 2,
    });
  });

  it("lists models in the OpenAI shape", async () => {
    const res = await app.request("/v1/models");
    const body = await json(res);
    expect(body.object).toBe("list");
    expect(body.data.map((m: any) => m.id)).toEqual(backend.models);
    expect(body.data[0]).toMatchObject({ object: "model", owned_by: "opencode" });
    expect(typeof body.data[0].created).toBe("number");
  });

  it("returns a single model", async () => {
    const res = await app.request("/v1/models/big-pickle");
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe("big-pickle");
  });

  it("answers 404 for a model that is not in the list", async () => {
    const res = await app.request("/v1/models/nope");
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Unknown model: nope");
    expect(body.error).toHaveProperty("param", null);
  });
});

describe("routing errors", () => {
  it("answers 404 for an unknown route", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe("Unknown route GET /nope");
  });

  it("reports a malformed body as an internal error", async () => {
    const res = await post("/v1/chat/completions", "{not json");
    expect(res.status).toBe(500);
    expect((await json(res)).error.type).toBe("upstream_error");
  });
});

describe("OpenAI chat completions", () => {
  it("answers a non-streaming completion", async () => {
    const res = await post("/v1/chat/completions", ask());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hi there");
    expect(body.usage.total_tokens).toBe(6);
  });

  it("strips the opencode/ prefix off the model", async () => {
    const res = await post("/v1/chat/completions", ask({ model: "opencode/big-pickle" }));
    expect(res.status).toBe(200);
    expect(backend.calls[0].modelId).toBe("big-pickle");
  });

  it("rejects an unknown model with 400", async () => {
    const res = await post("/v1/chat/completions", ask({ model: "nope" }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.message).toContain("Available: big-pickle, small-pickle");
  });

  it("rejects a request with no user turn", async () => {
    const res = await post("/v1/chat/completions", {
      model: "big-pickle",
      messages: [{ role: "system", content: "only system" }],
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toBe("No user message in request");
  });

  it("forwards the system prompt and the transcript to the backend", async () => {
    await post("/v1/chat/completions", {
      model: "big-pickle",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    expect(backend.calls[0]).toMatchObject({
      system: "Be brief.",
      transcript: "User: one\n\nAssistant: two\n\nUser: three",
      lastUserText: "three",
    });
  });
});

describe("Anthropic messages", () => {
  it("answers in the Anthropic shape", async () => {
    const res = await post("/v1/messages", ask());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  it("uses the Anthropic error envelope", async () => {
    const res = await post("/v1/messages", ask({ model: "nope" }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringContaining("Unknown model") },
    });
  });

  it("uses the top-level system field", async () => {
    await post("/v1/messages", { ...ask(), system: "Be brief." });
    expect(backend.calls[0].system).toBe("Be brief.");
  });
});

describe("conversation keys", () => {
  it("is stateless without a key", async () => {
    await post("/v1/chat/completions", ask());
    expect(backend.calls[0].key).toBeNull();
  });

  it("prefers the x-oc-session header over the body", async () => {
    await post("/v1/chat/completions", ask({ user: "body-user" }), { "x-oc-session": "header" });
    expect(backend.calls[0].key).toBe("header");
  });

  it("falls back to the OpenAI user field", async () => {
    await post("/v1/chat/completions", ask({ user: "body-user" }));
    expect(backend.calls[0].key).toBe("body-user");
  });

  it("falls back to the Anthropic metadata.user_id field", async () => {
    await post("/v1/messages", ask({ metadata: { user_id: "meta-user" } }));
    expect(backend.calls[0].key).toBe("meta-user");
  });
});

describe("tool calling", () => {
  const weather = [
    {
      type: "function",
      function: { name: "get_weather", description: "current weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    },
  ];
  /** What the model answers with when it wants the caller to run something. */
  const calling = (text = '```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```') =>
    (backend.answer = { content: [{ type: "text", text }], tokens: { input: 9, output: 3 }, finish: "stop" });

  it("tells the backend which functions the client offered", async () => {
    await post("/v1/chat/completions", ask({ tools: weather }));
    expect(backend.calls[0].toolNames).toEqual(["get_weather"]);
    expect(backend.calls[0].toolResults).toBe("");
  });

  it("offers no tools when the request declares none", async () => {
    await post("/v1/chat/completions", ask());
    expect(backend.calls[0].toolNames).toEqual([]);
    expect(backend.calls[0].directives).toBe("");
  });

  it("describes the functions to the model in its own words, apart from the client's system prompt", async () => {
    await post("/v1/chat/completions", {
      model: "big-pickle",
      tools: weather,
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hello" }],
    });
    // The client's system prompt is passed through as it was written...
    expect(backend.calls[0].system).toBe("Be brief.");
    // ...and how to call a function travels beside it, not inside it.
    expect(backend.calls[0].directives).toContain("get_weather: current weather");
    expect(backend.calls[0].directives).toContain('"city"');
  });

  it("answers with an OpenAI tool call", async () => {
    calling();
    const res = await post("/v1/chat/completions", ask({ tools: weather }));
    expect(res.status).toBe(200);
    const choice = (await json(res)).choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    // The block is the proxy's, so the answer beside it is empty.
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls[0]).toMatchObject({ id: expect.stringMatching(/^call_/), type: "function", function: { name: "get_weather" } });
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({ city: "Paris" });
  });

  it("keeps the prose the model wrote around the call", async () => {
    calling("Let me check.\n```tool_call\n{\"name\": \"get_weather\", \"arguments\": {}}\n```");
    const res = await post("/v1/chat/completions", ask({ tools: weather }));
    expect((await json(res)).choices[0].message.content).toBe("Let me check.");
  });

  it("answers with prose when the model used no block", async () => {
    calling("I could not check the weather.");
    const choice = (await json(await post("/v1/chat/completions", ask({ tools: weather })))).choices[0];
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe("I could not check the weather.");
    expect(choice.message.tool_calls).toBeUndefined();
  });

  it("does not answer with a call the client never declared", async () => {
    // The client's machine is the one that would run it, so a name it never offered is
    // not the proxy's to dispatch.
    calling('Listing it.\n```tool_call\n{"name": "list_dir", "arguments": {"path": "/tmp"}}\n```');
    const choice = (await json(await post("/v1/chat/completions", ask({ tools: weather })))).choices[0];
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.message.content).toBe("Listing it.");
  });

  it("takes a block it cannot read out of the answer", async () => {
    calling("Here is the format:\n```tool_call\nnot json at all\n```");
    const choice = (await json(await post("/v1/chat/completions", ask({ tools: weather })))).choices[0];
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.message.content).toBe("Here is the format:");
  });

  it("streams an undeclared call as the prose around it", async () => {
    calling('Listing it.\n```tool_call\n{"name": "list_dir", "arguments": {}}\n```');
    const res = await post("/v1/chat/completions", ask({ tools: weather, stream: true }));
    const { raw, frames } = await sse(res);
    expect(raw).not.toContain("tool_call");
    expect(frames.flatMap((f) => f.data?.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([]);
    expect(frames.filter((f) => f.data?.choices?.[0]?.finish_reason).at(-1)?.data.choices[0].finish_reason).toBe("stop");
  });

  it("leaves an undeclared call out of an Anthropic answer too", async () => {
    calling('Listing it.\n```tool_call\n{"name": "list_dir", "arguments": {}}\n```');
    const body = await json(await post("/v1/messages", ask({ tools: [{ name: "get_weather" }] })));
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content.map((b: any) => b.type)).toEqual(["text"]);
    expect(body.content[0].text).toBe("Listing it.");
  });

  it("streams a tool call as one answer rather than leaking the block", async () => {
    calling();
    const res = await post("/v1/chat/completions", ask({ tools: weather, stream: true }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { raw, frames } = await sse(res);
    expect(raw).not.toContain("tool_call\n");
    const call = frames.flatMap((f) => f.data?.choices?.[0]?.delta?.tool_calls ?? [])[0];
    expect(call).toMatchObject({ type: "function", function: { name: "get_weather" } });
    expect(frames.filter((f) => f.data?.choices?.[0]?.finish_reason).at(-1)?.data.choices[0].finish_reason).toBe("tool_calls");
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });

  it("streams prose before a tool call followed by the tool call and finish_reason tool_calls", async () => {
    calling('Let me check that for you.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>');
    backend.deltas = [
      { kind: "text", text: "Let me check that for you.\n" },
      { kind: "text", text: '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>' },
    ];
    const res = await post("/v1/chat/completions", ask({ tools: weather, stream: true }));
    const { frames } = await sse(res);
    const textDeltas = frames.map((f) => f.data?.choices?.[0]?.delta?.content).filter(Boolean);
    expect(textDeltas.join("")).toContain("Let me check that for you.");
    const call = frames.flatMap((f) => f.data?.choices?.[0]?.delta?.tool_calls ?? [])[0];
    expect(call).toMatchObject({ type: "function", function: { name: "get_weather" } });
    expect(frames.filter((f) => f.data?.choices?.[0]?.finish_reason).at(-1)?.data.choices[0].finish_reason).toBe("tool_calls");
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });

  it("still streams live deltas when no tools were offered", async () => {
    backend.deltas = [{ kind: "text", text: "hi " }, { kind: "text", text: "there" }];
    const res = await post("/v1/chat/completions", ask({ stream: true }));
    const { frames } = await sse(res);
    expect(frames.flatMap((f) => f.data?.choices?.[0]?.delta?.content ?? [])).toEqual(["hi ", "there"]);
  });

  it("answers with an Anthropic tool_use block", async () => {
    calling();
    const res = await post("/v1/messages", ask({ tools: [{ name: "get_weather", input_schema: {} }] }));
    const body = await json(res);
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "tool_use", id: expect.stringMatching(/^call_/), name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("streams an Anthropic tool_use block", async () => {
    calling();
    const res = await post("/v1/messages", ask({ tools: [{ name: "get_weather" }], stream: true }));
    const { frames } = await sse(res);
    const start = frames.find((f) => f.event === "content_block_start");
    expect(start?.data.content_block).toEqual({ type: "tool_use", id: expect.any(String), name: "get_weather", input: {} });
    const delta = frames.find((f) => f.event === "content_block_delta");
    expect(delta?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"city":"Paris"}' });
    expect(frames.at(-2)?.data.delta.stop_reason).toBe("tool_use");
    expect(frames.at(-1)?.event).toBe("message_stop");
  });

  it("forwards the result the client executed, with no new user text", async () => {
    const res = await post("/v1/chat/completions", {
      model: "big-pickle",
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_a", content: "18C and raining" },
      ],
      tools: weather,
    });
    // A result with nothing new to say is the next step of a turn in flight.
    expect(res.status).toBe(200);
    expect(backend.calls[0].toolNames).toEqual(["get_weather"]);
    expect(backend.calls[0].toolResults).toContain("`get_weather` (call_a)");
    expect(backend.calls[0].toolResults).toContain("18C and raining");
  });

  it("forwards an Anthropic tool_result block", async () => {
    const res = await post("/v1/messages", {
      model: "big-pickle",
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C" }] },
      ],
      tools: [{ name: "get_weather" }],
    });
    expect(res.status).toBe(200);
    expect(backend.calls[0].toolResults).toContain("18C");
    // The question was asked before the result and is not asked again.
    expect(backend.calls[0].lastUserText).toBe("");
  });

  it("asks a question that came after the result", async () => {
    await post("/v1/chat/completions", {
      model: "big-pickle",
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_a", content: "18C" },
        { role: "user", content: "and in Rome?" },
      ],
      tools: weather,
    });
    expect(backend.calls[0].lastUserText).toBe("and in Rome?");
  });

  it("still rejects a request with no user turn and no result", async () => {
    const res = await post("/v1/chat/completions", { model: "big-pickle", messages: [{ role: "system", content: "only system" }] });
    expect(res.status).toBe(400);
  });
});

describe("upstream failures", () => {
  it("keeps the status the backend reported", async () => {
    backend.fail = { status: 429, message: "rate limited" };
    const res = await post("/v1/chat/completions", ask());
    expect(res.status).toBe(429);
    expect((await json(res)).error.message).toBe("rate limited");
  });

  it("reports anything unexpected as a bad gateway", async () => {
    backend.fail = { status: 502, message: "opencode request failed" };
    const res = await post("/v1/chat/completions", ask());
    expect(res.status).toBe(502);
  });
});

describe("OpenAI streaming", () => {
  it("replays a whole answer as one SSE response", async () => {
    const res = await post("/v1/chat/completions", ask({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const { raw, frames } = await sse(res);
    // role -> content -> finish+usage -> [DONE]
    expect(frames[0].data.choices[0].delta).toEqual({ role: "assistant" });
    expect(frames[1].data.choices[0].delta).toEqual({ content: "hi there" });
    expect(frames[2].data.choices[0]).toMatchObject({ delta: {}, finish_reason: "stop" });
    expect(frames[2].data.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    expect(frames.at(-1)?.data).toBe("[DONE]");
    expect(raw).toContain("data: [DONE]");
  });

  it("streams live deltas and only appends the unseen tail", async () => {
    backend.deltas = [
      { kind: "reasoning", text: "think" },
      { kind: "text", text: "hi " },
      { kind: "text", text: "there" },
    ];
    // The fake answer already contains what was streamed, so the tail must be empty.
    backend.answer = {
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "hi there" },
      ],
      tokens: { input: 4, output: 2 },
      finish: "stop",
    };

    const res = await post("/v1/chat/completions", ask({ stream: true }));
    expect(res.status).toBe(200);
    const { raw, frames } = await sse(res);

    const deltas = frames.flatMap((f) => {
      const d = f.data?.choices?.[0]?.delta;
      return d ? [d] : [];
    });
    expect(deltas).toContainEqual({ reasoning_content: "think" });
    expect(deltas).toContainEqual({ content: "hi " });
    expect(deltas).toContainEqual({ content: "there" });
    // The full answer was already streamed, so finish() must not repeat it.
    expect(raw.match(/"hi there"/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(raw).toContain("[DONE]");
  });

  it("reports a failure before streaming as a JSON error, not an SSE frame", async () => {
    backend.fail = { status: 502, message: "opencode gave up" };
    const res = await post("/v1/chat/completions", ask({ stream: true }));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await json(res)).error.message).toBe("opencode gave up");
  });

  it("reports a failure after streaming began as an error frame", async () => {
    backend.deltas = [{ kind: "text", text: "partial" }];
    backend.fail = { status: 502, message: "died mid-answer" };
    const res = await post("/v1/chat/completions", ask({ stream: true }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("died mid-answer");
  });

  it("refuses to stream an empty answer", async () => {
    backend.answer = { content: [], tokens: {}, finish: "stop" };
    const res = await post("/v1/chat/completions", ask({ stream: true }));
    expect(res.status).toBe(502);
    expect((await json(res)).error.message).toBe("empty response from opencode");
  });
});

describe("Anthropic streaming", () => {
  it("wraps the answer in the message event sequence", async () => {
    const res = await post("/v1/messages", ask({ stream: true }));
    expect(res.status).toBe(200);
    const { frames } = await sse(res);
    const events = frames.map((f) => f.event);
    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[0].data.message.model).toBe("big-pickle");
    expect(frames.at(-2)?.data.delta.stop_reason).toBe("end_turn");
  });

  it("closes the text block before opening a thinking block", async () => {
    backend.deltas = [
      { kind: "reasoning", text: "hmm" },
      { kind: "text", text: "answer" },
    ];
    backend.answer = {
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "answer" },
      ],
      tokens: { input: 1, output: 1 },
      finish: "stop",
    };
    const res = await post("/v1/messages", ask({ stream: true }));
    const { frames } = await sse(res);
    const blocks = frames.filter((f) => f.event === "content_block_start");
    expect(blocks.map((b) => b.data.content_block.type)).toEqual(["thinking", "text"]);
    const deltas = frames.filter((f) => f.event === "content_block_delta").map((f) => f.data.delta.type);
    expect(deltas).toEqual(["thinking_delta", "text_delta"]);
  });
});
