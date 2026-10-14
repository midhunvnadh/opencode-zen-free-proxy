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
