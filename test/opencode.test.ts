import { beforeEach, describe, expect, it, vi } from "vitest";

// The interception loop is the part of the proxy that decides whether the backend runs a
// tool or hands it to the client. `api.test.ts` replaces the whole backend module, so
// this suite drives the real one against a scripted HTTP backend.
vi.mock("../src/config.ts", () => ({
  OC_SERVER: "http://127.0.0.1:65000",
  OC_USERNAME: "opencode",
  OC_PASSWORD: undefined,
  OC_BIN: "opencode",
  OC_WORKDIR: "/tmp/oc-test",
  REQUEST_TIMEOUT: 5000,
  KEYS_FILE: "/tmp/keys.json",
}));

const { askModel, start } = await import("../src/opencode.ts");

/** The scripted backend: what the model asks for, and what it answers once it is told. */
const fake = {
  /** A tool the model reaches for on the first turn, or null to just answer. */
  reach: null as null | { name: string; args: Record<string, unknown> },
  /** Whether it keeps reaching on every turn instead of just the first. */
  keepReaching: false,
  /** A call the model announces in its answer as text, which is a different thing from
   *  reaching for a tool: no permission is ever asked for it. */
  fence: null as null | { name: string; args: Record<string, unknown> },
  /** Whether it keeps announcing one instead of just the first turn. */
  keepFencing: false,
  answer: "all done" as string,
  prompts: [] as string[],
  created: [] as any[],
  rejected: [] as string[],
  deleted: [] as string[],
};

const CALL_ID = "call_1";

let permission: any = null;
/** What the session will hold once the turn ends — never set before, as the real
 *  backend only produces a message when it is done answering. */
let finished: any = null;
let message: any = null;
let waiter: (() => void) | null = null;

const assistant = (text: string) => ({
  id: "msg_1",
  type: "assistant",
  time: { created: 1 },
  content: [{ type: "text", text }],
  tokens: { input: 5, output: 2 },
  finish: "stop",
});

const json = (data: unknown, status = 200) => ({ status, text: async () => JSON.stringify({ data }) });

beforeEach(async () => {
  fake.reach = null;
  fake.keepReaching = false;
  fake.fence = null;
  fake.keepFencing = false;
  fake.answer = "all done";
  fake.prompts = [];
  fake.created = [];
  fake.rejected = [];
  fake.deleted = [];
  permission = null;
  finished = null;
  message = null;
  waiter = null;

  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const path = String(url).replace("http://127.0.0.1:65000", "");
    const body = init?.body ? JSON.parse(init.body) : {};

    if (path === "/api/session" && init.method === "POST") {
      fake.created.push(body);
      return json({ id: "ses_1" });
    }
    if (path.endsWith("/prompt")) {
      fake.prompts.push(body.text);
      // A tool only blocks when the session was opened with the ask rule; otherwise it
      // runs there and then, exactly as it always has.
      if (fake.reach && fake.created.at(-1)?.permissions) {
        const { name, args } = fake.reach;
        if (!fake.keepReaching) fake.reach = null;
        permission = { id: "per_1", sessionID: "ses_1", action: name, source: { type: "tool", id: CALL_ID, messageID: "msg_1" } };
        message = { ...assistant(""), content: [{ type: "tool", id: CALL_ID, name, state: { status: "running", input: args } }] };
      } else if (fake.fence && fake.created.at(-1)?.permissions) {
        // The model announced a call in its answer instead of reaching for one, so the
        // turn ends by itself and nothing was ever asked for permission.
        const { name, args } = fake.fence;
        if (!fake.keepFencing) fake.fence = null;
        finished = assistant("```tool_call\n" + JSON.stringify({ name, arguments: args }) + "\n```");
      } else {
        finished = assistant(fake.reach ? "the tool ran here" : fake.answer);
      }
      return json({ id: "msg_1" });
    }
    if (path.endsWith("/wait")) {
      // A blocked tool never ends the turn on its own, which is what the proxy races.
      if (permission) await new Promise<void>((resolve) => (waiter = resolve));
      // The answer only exists once the turn is over.
      message = finished;
      return { status: 204, text: async () => "" };
    }
    if (path.endsWith("/permission") && init.method === "GET") {
      return json(permission ? [permission] : []);
    }
    if (path.includes("/permission/") && path.endsWith("/reply")) {
      fake.rejected.push(body.decision);
      permission = null;
      waiter?.();
      waiter = null;
      return { status: 204, text: async () => "" };
    }
    if (path.endsWith("/message")) return json([message]);
    if (path.startsWith("/api/session/") && init.method === "DELETE") {
      fake.deleted.push(path);
      return { status: 200, text: async () => "" };
    }
    throw new Error(`unexpected request ${init.method} ${path}`);
  });

  await start();
});

describe("a session without client tools", () => {
  it("is created with no permission rules, so opencode runs its own tools as before", async () => {
    const message = await askModel({ key: null, modelId: "big-pickle", system: "", transcript: "", lastUserText: "hello" });
    expect(fake.created[0].permissions).toBeUndefined();
    expect(message.content[0].text).toBe("all done");
    expect(fake.deleted).toHaveLength(1);
  });

  it("never asks for permission", async () => {
    await askModel({ key: null, modelId: "big-pickle", system: "", transcript: "", lastUserText: "hello" });
    expect(fake.rejected).toEqual([]);
  });
});

describe("a session with client tools", () => {
  it("asks before every tool, which is what puts a stop in front of it", async () => {
    await askModel({ key: "plain", modelId: "big-pickle", system: "", transcript: "", lastUserText: "hi", toolNames: ["get_weather"] });
    expect(fake.created[0].permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  });

  it("stops a tool of the model's own and tells it the tool is not available", async () => {
    fake.reach = { name: "shell", args: { command: "rm -rf /" } };
    const message = await askModel({
      key: "reached",
      modelId: "big-pickle",
      system: "",
      transcript: "",
      lastUserText: "clean up",
      toolNames: ["get_weather"],
    });
    // It was stopped where it stood: the decision was reject, not a permission grant.
    expect(fake.rejected).toEqual(["reject"]);
    expect(message.content[0].text).toBe("all done");
    // The model is pointed at the caller's functions rather than left to give up.
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]).toContain("`shell`");
    expect(fake.prompts[1]).toContain("not available");
    // It is pointed at what it can call instead, in the words it was given them in.
    expect(fake.prompts[1]).toContain("get_weather");
    expect(fake.prompts[1]).toContain("tool_call block");
  });

  it("gives up on a model that keeps reaching for tools it does not have", async () => {
    fake.reach = { name: "shell", args: {} };
    fake.keepReaching = true;
    await expect(
      askModel({ key: "stubborn", modelId: "big-pickle", system: "", transcript: "", lastUserText: "go", toolNames: ["get_weather"] })
    ).rejects.toThrow("kept reaching for tools");
    // Bounded: it does not keep paying for turns the model cannot finish.
    expect(fake.prompts).toHaveLength(3);
  });

  it("never watches for a tool when the client offered none", async () => {
    fake.reach = { name: "shell", args: {} };
    const message = await askModel({ key: "unwatched", modelId: "big-pickle", system: "", transcript: "", lastUserText: "clean up" });
    // No permission rules, so the model keeps the tools it always had and they run there.
    expect(fake.created[0].permissions).toBeUndefined();
    expect(fake.rejected).toEqual([]);
    expect(fake.prompts).toHaveLength(1);
    expect(message.content[0].text).toBe("the tool ran here");
  });
});

describe("a model that announces a function the client never offered", () => {
  const askWithTools = (key: string) =>
    askModel({ key, modelId: "big-pickle", system: "", transcript: "", lastUserText: "list /tmp", toolNames: ["read_log"] });

  it("is not handed over, and is pointed at what it can call instead", async () => {
    fake.fence = { name: "list_dir", args: { path: "/tmp" } };
    const message = await askWithTools("undeclared");
    // Nothing ran and nothing was refused: this arrived as answer text, never as a tool
    // opencode tried to run, so there is no permission to reject.
    expect(fake.rejected).toEqual([]);
    // The round a permission would have cost buys the model an answer instead.
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]).toContain("`list_dir`");
    expect(fake.prompts[1]).toContain("read_log");
    expect(message.content[0].text).toBe("all done");
  });

  it("gives up on a model that keeps announcing one", async () => {
    fake.fence = { name: "list_dir", args: {} };
    fake.keepFencing = true;
    await expect(askWithTools("stubborn-fence")).rejects.toThrow("kept reaching for tools");
    // Bounded by the same budget a permission costs, not a second one.
    expect(fake.prompts).toHaveLength(3);
  });

  it("spends no round on it when the client offered no functions", async () => {
    fake.fence = { name: "list_dir", args: {} };
    await askModel({ key: "no-tools", modelId: "big-pickle", system: "", transcript: "", lastUserText: "list /tmp" });
    // There is no list to point at, so there is nothing to say and nothing to spend.
    expect(fake.prompts).toHaveLength(1);
  });
});

describe("the tool result the client sends back", () => {
  it("follows the request", async () => {
    await askModel({
      key: "result",
      modelId: "big-pickle",
      system: "",
      transcript: "User: weather?",
      lastUserText: "",
      toolNames: ["get_weather"],
      toolResults: "Tool `get_weather` (call_1) returned:\n\n18C",
      directives: "call them with a tool_call block",
    });
    expect(fake.prompts[0]).toBe("User: weather?\n\nTool `get_weather` (call_1) returned:\n\n18C\n\ncall them with a tool_call block");
  });

  it("is the whole prompt when the client sent no new words", async () => {
    await askModel({
      key: "result-only",
      modelId: "big-pickle",
      system: "",
      transcript: "",
      lastUserText: "",
      toolNames: ["get_weather"],
      toolResults: "Tool `get_weather` (call_1) returned:\n\n18C",
    });
    expect(fake.prompts[0]).toBe("Tool `get_weather` (call_1) returned:\n\n18C");
  });
});

describe("conversations", () => {
  it("keeps the session and continues it after the first turn", async () => {
    const first = { key: "chat", modelId: "big-pickle", system: "", transcript: "User: one", lastUserText: "one" };
    await askModel(first);
    await askModel({ ...first, transcript: "User: one\n\nAssistant: hi\n\nUser: two", lastUserText: "two" });
    expect(fake.created).toHaveLength(1);
    // Only the first turn replays the transcript; later turns send just the new words.
    expect(fake.prompts[0]).toBe("User: one");
    expect(fake.prompts[1]).toBe("two");
  });

  it("opens a new session when a tool arrives for one that was created without", async () => {
    // Interception cannot be added to a live session, so a plain request first and a
    // tool request after must not share it - otherwise the tool would run here.
    await askModel({ key: "mixed", modelId: "big-pickle", system: "", transcript: "", lastUserText: "hi" });
    await askModel({ key: "mixed", modelId: "big-pickle", system: "", transcript: "", lastUserText: "hi", toolNames: ["t"] });
    expect(fake.created).toHaveLength(2);
    expect(fake.created[0].permissions).toBeUndefined();
    expect(fake.created[1].permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  });
});