import { readFile, writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The live suite: the real app, a real `opencode serve`, a real model.
 *
 * Everything else in `test/` runs against a fake backend, which is what keeps the suite
 * deterministic and CI free of a model. That is also what makes those tests blind to
 * whether the backend actually behaves this way. This suite is the other half, and it
 * only runs when asked:
 *
 *   opencode serve --port 0 --hostname 127.0.0.1
 *   OC_SERVER=http://127.0.0.1:<port> bun run test:live
 *
 * A model takes seconds to think and some of these drive several turns, so the budgets
 * here are generous and nothing in this file is part of `bun run check`.
 */

const LIVE = process.env.LIVE === "1";

// `config.ts` resolves the backend binary at import, and that lookup is the only thing
// on the path that needs Bun. Naming it keeps the whole suite on plain Node.
process.env.OC_BIN ||= "opencode";

const { createApp } = await import("../src/app.ts");
const { start } = await import("../src/opencode.ts");
const app = createApp();

const json = async (res: Response) => JSON.parse(await res.text());

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** An SSE body read once: the raw text, and its JSON frames in order. The OpenAI `[DONE]`
 *  sentinel is not JSON, so it stays in the text and out of the frames. */
const sse = async (res: Response) => {
  const raw = await res.text();
  const frames: { event: string | undefined; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    const frame: { event: string | undefined; data: any } = { event: undefined, data: undefined };
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) frame.event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        try {
          frame.data = JSON.parse(line.slice(5).trim());
        } catch {}
      }
    }
    if (frame.data) frames.push(frame);
  }
  return { raw, frames };
};

const DONE = (raw: string) => raw.includes("data: [DONE]");

/** A file the tool below reads, holding a token no model could guess. */
let logPath = "";
let token = "";
/** Whatever the backend offers first. */
let model = "";

const TOOL_SPEC = {
  name: "read_log",
  description: "Read a file from disk and return its contents.",
  input_schema: { type: "object", properties: { path: { type: "string", description: "absolute path" } }, required: ["path"] },
};
/** The same function as each dialect writes it. */
const OPENAI_TOOLS = [{ type: "function", function: { ...TOOL_SPEC, parameters: TOOL_SPEC.input_schema } }];
const ANTHROPIC_TOOLS = [TOOL_SPEC];

const ask = (path: string) => `Use the read_log tool to read ${path} and reply with just the token it contains.`;
const readTheLog = () => readFile(logPath, "utf8");

/**
 * The model, not the proxy, decides whether to reach for a caller's function: opencode
 * has no way to put the caller's tools in front of it, so it is asked in the prompt and
 * sometimes answers in prose instead. Measured across the models opencode offers it is
 * most, not all, of the time — so these tests ask again rather than assert on a coin
 * flip. What is being verified is the exchange, which is the proxy's whole to hold.
 */
async function askForTheTool(body: any, attempts = 4): Promise<any> {
  let answer: any;
  for (let i = 0; i < attempts; i++) {
    answer = (await json(await post("/v1/chat/completions", body))).choices[0];
    if (answer.finish_reason === "tool_calls") return answer;
  }
  throw new Error(`the model answered in prose ${attempts} times running: ${answer?.message?.content}`);
}

beforeAll(async () => {
  if (!LIVE) return;
  token = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  logPath = `${process.env.TMPDIR ?? "/tmp"}/proxy-live-${process.pid}.txt`;
  await writeFile(logPath, `the token is ${token}\n`);
  await start();
  model = await (await app.request("/v1/models")).json().then((list: any) => list.data[0].id as string);
}, 120_000);

describe.skipIf(!LIVE)("live, against a real opencode", () => {
  it("lists the backend's models", async () => {
    const body = await json(await app.request("/v1/models"));
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  }, 30_000);

  it("answers a plain request", async () => {
    const body = await json(await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "Say hi." }] }));
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
  }, 180_000);

  it("streams a plain request as a stream", async () => {
    const res = await post("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "Count from one to five." }],
      stream: true,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { raw, frames } = await sse(res);
    // Every frame is a completion chunk and they reassemble into the answer. How many
    // arrive is the model's business — a short answer may land in one — and whether it
    // counts in digits or in words is its business too.
    expect(frames.every((f) => f.data.object === "chat.completion.chunk")).toBe(true);
    expect(frames.flatMap((f) => f.data?.choices?.[0]?.delta?.content ?? []).join("")).toMatch(/five|5/i);
    expect(DONE(raw)).toBe(true);
  }, 180_000);

  it("hands a tool call to the client and takes the result back", async () => {
    const messages: any[] = [{ role: "user", content: ask(logPath) }];
    const choice = await askForTheTool({ model, messages, tools: OPENAI_TOOLS });

    expect(choice.message.tool_calls[0].function.name).toBe("read_log");
    // The model was given the real schema, so the arguments come back in it.
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments).path).toBe(logPath);

    const call = choice.message.tool_calls[0];
    messages.push({ role: "assistant", content: choice.message.content, tool_calls: [call] });
    messages.push({ role: "tool", tool_call_id: call.id, content: await readTheLog() });

    const done = (await json(await post("/v1/chat/completions", { model, messages, tools: OPENAI_TOOLS }))).choices[0];
    expect(done.finish_reason).toBe("stop");
    // The answer came from what the client ran, not from a tool of opencode's own.
    expect(done.message.content).toContain(token);
    expect(done.message.tool_calls).toBeUndefined();
  }, 300_000);

  it("streams a tool call without leaking the block it was written in", async () => {
    const res = await post("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: ask(logPath) }],
      tools: OPENAI_TOOLS,
      stream: true,
    });
    const { raw, frames } = await sse(res);
    // The block is the proxy's own convention, so it must not reach the client as answer
    // text. The model is free to quote it while thinking, which is not the same thing.
    expect(frames.flatMap((f) => f.data?.choices?.[0]?.delta?.content ?? []).join("")).not.toContain("tool_call");
    expect(frames.flatMap((f) => f.data?.choices?.[0]?.delta?.tool_calls ?? [])[0].function.name).toBe("read_log");
    expect(frames.filter((f) => f.data?.choices?.[0]?.finish_reason).at(-1)?.data.choices[0].finish_reason).toBe("tool_calls");
    expect(DONE(raw)).toBe(true);
  }, 300_000);

  it("runs the same exchange on the Anthropic route", async () => {
    const first = await json(
      await post("/v1/messages", { model, max_tokens: 2048, messages: [{ role: "user", content: ask(logPath) }], tools: ANTHROPIC_TOOLS })
    );
    expect(first.stop_reason).toBe("tool_use");
    const block = first.content.find((b: any) => b.type === "tool_use");
    expect(block.name).toBe("read_log");
    expect(block.input.path).toBe(logPath);

    const done = await json(
      await post("/v1/messages", {
        model,
        max_tokens: 2048,
        messages: [
          { role: "user", content: ask(logPath) },
          { role: "assistant", content: [{ type: "tool_use", id: block.id, name: block.name, input: block.input }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: await readTheLog() }] },
        ],
        tools: ANTHROPIC_TOOLS,
      })
    );
    expect(done.stop_reason).toBe("end_turn");
    expect(done.content.map((b: any) => b.text).join("")).toContain(token);
  }, 300_000);
});