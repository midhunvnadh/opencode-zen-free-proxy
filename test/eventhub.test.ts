import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", () => ({
  OC_SERVER: "http://127.0.0.1:65000",
  OC_USERNAME: "opencode",
  OC_PASSWORD: undefined,
  OC_BIN: "opencode",
  OC_WORKDIR: "/tmp/oc-test",
  REQUEST_TIMEOUT: 5000,
  KEYS_FILE: "/tmp/keys.json",
}));

import { EventHub, KNOWN_MODELS, listModels, modelCount } from "../src/opencode.ts";

describe("EventHub shared SSE connection & routing", () => {
  it("initializes in DISCONNECTED state with 0 subscribers", () => {
    const hub = new EventHub(() => "http://127.0.0.1:9999", () => null);
    const stats = hub.stats();
    expect(stats.state).toBe("DISCONNECTED");
    expect(stats.subscribers).toBe(0);
    expect(stats.events).toBe(0);
  });

  it("subscribes and routes events by session ID", () => {
    const hub = new EventHub(() => "http://127.0.0.1:9999", () => null);

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const sinkA: any = {
      delta: (_kind: string, text: string) => {
        receivedA.push(text);
      },
    };
    const sinkB: any = {
      delta: (_kind: string, text: string) => {
        receivedB.push(text);
      },
    };

    const subA = hub.subscribe({ sid: "ses_A", sink: sinkA });
    const subB = hub.subscribe({ sid: "ses_B", sink: sinkB });

    expect(hub.stats().subscribers).toBe(2);

    // Simulate SSE frames arriving via internal dispatch
    const dispatch = (hub as any).dispatchFrame.bind(hub);

    dispatch('data: {"type":"session.text.delta","data":{"sessionID":"ses_A","delta":"Hello A"}}\n\n');
    dispatch('data: {"type":"session.text.delta","data":{"sessionID":"ses_B","delta":"Hello B"}}\n\n');
    dispatch('data: {"type":"session.reasoning.delta","data":{"sessionID":"ses_A","delta":"Thinking A"}}\n\n');
    dispatch('data: {"type":"session.text.delta","data":{"sessionID":"ses_other","delta":"Ignored"}}\n\n');

    expect(receivedA).toEqual(["Hello A", "Thinking A"]);
    expect(receivedB).toEqual(["Hello B"]);

    subA.close();
    expect(hub.stats().subscribers).toBe(1);

    subB.close();
    expect(hub.stats().subscribers).toBe(0);
    hub.stop();
  });
});

describe("Model discovery & static fallback", () => {
  it("includes expected models in KNOWN_MODELS", () => {
    expect(KNOWN_MODELS).toContain("big-pickle");
    expect(KNOWN_MODELS).toContain("nemotron-3.5-lightning-free");
    expect(KNOWN_MODELS).toContain("mimo-v2.6-flash-free");
    expect(KNOWN_MODELS.length).toBeGreaterThan(5);
  });

  it("falls back to KNOWN_MODELS on backend failure", async () => {
    const models = await listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(modelCount()).toBe(models.length);
  });
});
