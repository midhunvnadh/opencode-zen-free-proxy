import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the network calls in opencode.ts to script backend behavior
const fake = {
  sessionsCreated: [] as any[],
  promptsSent: [] as { sid: string; text: string; system: string }[],
  assistantReplies: [] as any[],
  deletedSessions: [] as string[],
};

vi.mock("../src/config.ts", () => ({
  OC_SERVER: "http://127.0.0.1:65000",
  OC_USERNAME: "opencode",
  OC_PASSWORD: undefined,
  OC_BIN: "opencode",
  OC_WORKDIR: "/tmp/oc-test-mem",
  REQUEST_TIMEOUT: 5000,
  KEYS_FILE: "/tmp/keys-mem.json",
}));

const { askModel, start } = await import("../src/opencode.ts");
const { globalRegistry } = await import("../src/registry.ts");

const assistant = (text: string, toolCalls?: any[]) => ({
  id: "msg_" + Math.random().toString(36).slice(2),
  type: "assistant",
  time: { created: Date.now() },
  content: [{ type: "text", text }],
  parts: [{ type: "text", text }],
  tokens: { input: 10, output: 5 },
  finish: toolCalls ? "tool_calls" : "stop",
  ...(toolCalls ? { tool_calls: toolCalls } : {}),
});

const json = (data: unknown, status = 200) => ({
  status,
  text: async () => JSON.stringify({ data }),
});

let sessionCounter = 0;

beforeEach(async () => {
  fake.sessionsCreated = [];
  fake.promptsSent = [];
  fake.assistantReplies = [];
  fake.deletedSessions = [];
  globalRegistry.clear();
  sessionCounter = 0;

  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const path = String(url).replace("http://127.0.0.1:65000", "");
    const body = init?.body ? JSON.parse(init.body) : {};

    if (path === "/api/session" && init.method === "POST") {
      sessionCounter++;
      const id = `ses_${sessionCounter}`;
      fake.sessionsCreated.push({ id, ...body });
      return json({ id });
    }
    if (path.endsWith("/prompt")) {
      const sid = path.split("/")[3];
      fake.promptsSent.push({ sid, text: body.text, system: "" });
      return json({ id: "msg_sent" });
    }
    if (path.endsWith("/wait")) {
      return { status: 204, text: async () => "" };
    }
    if (path.endsWith("/permission") && init.method === "GET") {
      return json([]);
    }
    if (path.endsWith("/message")) {
      const reply = fake.assistantReplies.shift() || assistant("default answer");
      return json([reply]);
    }
    if (path.startsWith("/api/session/") && init.method === "DELETE") {
      fake.deletedSessions.push(path);
      return { status: 200, text: async () => "" };
    }
    if (path === "/api/model") {
      return json([{ providerID: "opencode", id: "big-pickle" }]);
    }
    throw new Error(`unexpected request ${init.method} ${path}`);
  });

  await start();
});

describe("Transparent multi-turn memory without x-oc-session header", () => {
  it("reuses backend session and sends only delta on append turn", async () => {
    fake.assistantReplies.push(assistant("Hello! How can I help you today?"));

    // Turn 1
    const turn1Messages = [{ role: "user", content: "hello" }];
    const res1 = await askModel({
      key: null,
      modelId: "big-pickle",
      system: "You are a helpful assistant.",
      transcript: "User: hello",
      lastUserText: "hello",
      messages: turn1Messages,
    });

    expect(fake.sessionsCreated).toHaveLength(1);
    const sid = fake.sessionsCreated[0].id;
    expect(fake.promptsSent).toHaveLength(1);
    expect(fake.promptsSent[0].sid).toBe(sid);
    expect(fake.promptsSent[0].text).toContain("hello");
    // Session is kept alive in registry, NOT deleted
    expect(fake.deletedSessions).toHaveLength(0);

    // Turn 2: User sends conversation history + new turn
    fake.assistantReplies.push(assistant("Paris is the capital of France."));
    const turn2Messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello! How can I help you today?" },
      { role: "user", content: "what is the capital of France?" },
    ];

    const res2 = await askModel({
      key: null,
      modelId: "big-pickle",
      system: "You are a helpful assistant.",
      transcript: "User: hello\n\nAssistant: Hello! How can I help you today?\n\nUser: what is the capital of France?",
      lastUserText: "what is the capital of France?",
      messages: turn2Messages,
    });

    // Did NOT create a second session! Reused sid!
    expect(fake.sessionsCreated).toHaveLength(1);
    expect(fake.promptsSent).toHaveLength(2);
    expect(fake.promptsSent[1].sid).toBe(sid);

    // Delta prompt only sent the new user text, NOT re-echoing the assistant text
    expect(fake.promptsSent[1].text).toBe("User: what is the capital of France?");
    expect(fake.promptsSent[1].text).not.toContain("Hello! How can I help you today?");
  });

  it("forces a fresh session resync when conversation history diverged (edited message)", async () => {
    fake.assistantReplies.push(assistant("Answer to original"));

    // Turn 1
    const turn1Messages = [{ role: "user", content: "original question" }];
    await askModel({
      key: null,
      modelId: "big-pickle",
      system: "",
      transcript: "User: original question",
      lastUserText: "original question",
      messages: turn1Messages,
    });
    expect(fake.sessionsCreated).toHaveLength(1);
    const sid1 = fake.sessionsCreated[0].id;

    // Turn 2 with EDITED first message -> divergence!
    fake.assistantReplies.push(assistant("Answer to edited"));
    const divergedMessages = [
      { role: "user", content: "edited question" },
      { role: "assistant", content: "Answer to edited" },
      { role: "user", content: "followup" },
    ];

    await askModel({
      key: null,
      modelId: "big-pickle",
      system: "",
      transcript: "User: edited question\n\nAssistant: Answer to edited\n\nUser: followup",
      lastUserText: "followup",
      messages: divergedMessages,
    });

    // Created a new session because prefix did not match
    expect(fake.sessionsCreated).toHaveLength(2);
    const sid2 = fake.sessionsCreated[1].id;
    expect(sid2).not.toBe(sid1);
    expect(fake.promptsSent[1].sid).toBe(sid2);
    // Full transcript replayed
    expect(fake.promptsSent[1].text).toContain("edited question");
  });

  it("skips resending tool instructions on delta turns when tools signature is unchanged", async () => {
    const weatherTool = [{ type: "function", function: { name: "get_weather" } }];
    fake.assistantReplies.push(assistant("Calling weather", [{ id: "call_1", function: { name: "get_weather", arguments: "{}" } }]));

    // Turn 1: with tools
    const turn1Messages = [{ role: "user", content: "weather in Paris?" }];
    await askModel({
      key: null,
      modelId: "big-pickle",
      system: "",
      transcript: "User: weather in Paris?",
      lastUserText: "weather in Paris?",
      directives: "TOOLS_CONTRACT_BLOCK",
      toolNames: ["get_weather"],
      messages: turn1Messages,
      tools: weatherTool,
    });

    expect(fake.sessionsCreated).toHaveLength(1);
    // Turn 1 prompt included tool directives
    expect(fake.promptsSent[0].text).toContain("TOOLS_CONTRACT_BLOCK");

    // Turn 2: tool result returned
    fake.assistantReplies.push(assistant("It is sunny in Paris."));
    const turn2Messages = [
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: "Calling weather",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "Sunny, 22C" },
    ];

    await askModel({
      key: null,
      modelId: "big-pickle",
      system: "",
      transcript: "User: weather in Paris?",
      lastUserText: "",
      directives: "TOOLS_CONTRACT_BLOCK",
      toolNames: ["get_weather"],
      toolResults: "[tool result: get_weather] (call call_1)\n<result>\nSunny, 22C\n</result>",
      messages: turn2Messages,
      tools: weatherTool,
    });

    // Reused session
    expect(fake.sessionsCreated).toHaveLength(1);
    // Continuation delta prompt did NOT resend redundant TOOLS_CONTRACT_BLOCK!
    expect(fake.promptsSent[1].text).not.toContain("TOOLS_CONTRACT_BLOCK");
    // But contains the tool result
    expect(fake.promptsSent[1].text).toContain("[tool result: get_weather] (call call_1)");
  });
});
