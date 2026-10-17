import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestsOf,
  dropEchoedAssistant,
  msgDigest,
  Registry,
  shouldSendToolBlock,
  toolsSignature,
} from "../src/registry.ts";

describe("canonicalJson & digests", () => {
  it("produces identical JSON regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { y: "hi", x: "bye" } };
    const b = { a: 2, c: { x: "bye", y: "hi" }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(msgDigest(a)).toBe(msgDigest(b));
  });

  it("produces digests for an array of messages", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const digs = digestsOf(msgs);
    expect(digs).toHaveLength(2);
    expect(digs[0]).toHaveLength(64);
    expect(digs[1]).toHaveLength(64);
    expect(digs[0]).not.toBe(digs[1]);
  });
});

describe("toolsSignature", () => {
  it("changes when tool list or tool choice changes", () => {
    const sig1 = toolsSignature([{ name: "tool1" }]);
    const sig2 = toolsSignature([{ name: "tool2" }]);
    const sig3 = toolsSignature([{ name: "tool1" }], "required");
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
  });

  it("is stable across key ordering in tool definitions", () => {
    const sigA = toolsSignature([{ name: "f", description: "d" }]);
    const sigB = toolsSignature([{ description: "d", name: "f" }]);
    expect(sigA).toBe(sigB);
  });
});

describe("Registry prefix matching", () => {
  it("matches when incoming digests start with stored digests (append turn)", () => {
    const reg = new Registry();
    const m1 = { role: "user", content: "hello" };
    const m2 = { role: "assistant", content: "hi" };
    const m3 = { role: "user", content: "how are you?" };

    const digs1 = digestsOf([m1, m2]);
    const sig = toolsSignature([]);
    reg.record(digs1, "ses_1", "hi", "", sig);

    const digs2 = digestsOf([m1, m2, m3]);
    const matched = reg.match(digs2, sig);
    expect(matched).not.toBeNull();
    expect(matched?.sid).toBe("ses_1");
  });

  it("fails to match if history diverged (edited message)", () => {
    const reg = new Registry();
    const m1 = { role: "user", content: "hello" };
    const m1_edited = { role: "user", content: "hello edited" };
    const m2 = { role: "assistant", content: "hi" };
    const m3 = { role: "user", content: "how are you?" };

    const digs1 = digestsOf([m1, m2]);
    const sig = toolsSignature([]);
    reg.record(digs1, "ses_1", "hi", "", sig);

    const digsDiverged = digestsOf([m1_edited, m2, m3]);
    const matched = reg.match(digsDiverged, sig);
    expect(matched).toBeNull();
  });

  it("fails to match if tool signature changed", () => {
    const reg = new Registry();
    const m1 = { role: "user", content: "hello" };
    const m2 = { role: "assistant", content: "hi" };
    const m3 = { role: "user", content: "check weather" };

    const digs1 = digestsOf([m1, m2]);
    const sig1 = toolsSignature([]);
    reg.record(digs1, "ses_1", "hi", "", sig1);

    const digs2 = digestsOf([m1, m2, m3]);
    const sig2 = toolsSignature([{ name: "get_weather" }]);
    const matched = reg.match(digs2, sig2);
    expect(matched).toBeNull();
  });

  it("ignores tainted sessions", () => {
    const reg = new Registry();
    const m1 = { role: "user", content: "hello" };
    const digs = digestsOf([m1]);
    const sig = toolsSignature([]);
    reg.record(digs, "ses_1", "hi", "", sig);
    reg.markTainted("ses_1");

    expect(reg.match(digs, sig)).toBeNull();
  });

  it("evicts oldest entry when maxEntries is reached", () => {
    const reg = new Registry(2);
    const sig = toolsSignature([]);
    reg.record(["d1"], "ses_1", "r1", "", sig);
    reg.record(["d2"], "ses_2", "r2", "", sig);
    reg.record(["d3"], "ses_3", "r3", "", sig);

    expect(reg.size).toBe(2);
    expect(reg.match(["d1"], sig)).toBeNull();
    expect(reg.match(["d2"], sig)?.sid).toBe("ses_2");
    expect(reg.match(["d3"], sig)?.sid).toBe("ses_3");
  });
});

describe("shouldSendToolBlock", () => {
  const sig = toolsSignature([{ name: "f" }]);
  const entry = {
    digests: ["d1"],
    sid: "ses_1",
    lastReply: "hi",
    lastReasoning: "",
    toolsSig: sig,
    used: 1,
    tainted: false,
  };

  it("returns true on resync / first turn", () => {
    expect(shouldSendToolBlock("resync", entry, true, sig)).toBe(true);
  });

  it("returns false on delta when toolsSig is unchanged", () => {
    expect(shouldSendToolBlock("delta", entry, true, sig)).toBe(false);
  });

  it("returns true on delta if toolsSig changed", () => {
    expect(shouldSendToolBlock("delta", entry, true, "different-sig")).toBe(true);
  });

  it("returns false if there are no tools", () => {
    expect(shouldSendToolBlock("resync", entry, false, sig)).toBe(false);
  });
});

describe("dropEchoedAssistant", () => {
  it("drops assistant echo matching lastReply", () => {
    const tail = [
      { role: "assistant", content: "Paris is sunny." },
      { role: "user", content: "What about London?" },
    ];
    const stripped = dropEchoedAssistant(tail, "Paris is sunny.", "");
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content).toBe("What about London?");
  });

  it("never drops assistant turn carrying tool_calls", () => {
    const tail = [
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Rainy" },
    ];
    const stripped = dropEchoedAssistant(tail, "Let me check.", "");
    expect(stripped).toHaveLength(2);
    expect(stripped[0].tool_calls).toBeDefined();
  });
});
