import { describe, expect, it } from "vitest";
import {
  findNextOpen,
  partialOpenHold,
  streamingView,
  ToolCallStreamParser,
} from "../src/protocols.ts";

describe("ToolCallStreamParser & streaming markers", () => {
  it("detects opening markers accurately", () => {
    expect(findNextOpen("Hello <tool_call>world", 0)).toMatchObject({ idx: 6, open: "<tool_call>", close: "</tool_call>" });
    expect(findNextOpen("Hello ```tool_call\nworld", 0)).toMatchObject({ idx: 6, open: "```tool_call", close: "```" });
    expect(findNextOpen("Hello [tool_call]world", 0)).toMatchObject({ idx: 6, open: "[tool_call]", close: "[/tool_call]" });
    expect(findNextOpen("Just text", 0)).toBeNull();
  });

  it("calculates partial opener hold to prevent syntax leakage", () => {
    expect(partialOpenHold("Here is: <tool")).toBe(5);
    expect(partialOpenHold("Here is: <")).toBe(1);
    expect(partialOpenHold("Here is: ```tool")).toBe(7);
    expect(partialOpenHold("Here is: [tool_call")).toBe(10);
    expect(partialOpenHold("Plain text ending in words")).toBe(0);
  });

  it("streamingView holds incomplete opening prefixes", () => {
    const { clean, calls } = streamingView("Hello world: <tool", ["test_tool"]);
    expect(clean).toBe("Hello world: ");
    expect(calls).toEqual([]);
  });

  it("streamingView holds open tool call blocks until closer arrives", () => {
    const { clean, calls } = streamingView('I will check.\n<tool_call>\n{"name": "test_tool", "arguments":', ["test_tool"]);
    expect(clean).toBe("I will check.\n");
    expect(calls).toEqual([]);
  });

  it("streamingView parses complete tool call and strips marker from clean text", () => {
    const text = 'I will check.\n<tool_call>\n{"name": "test_tool", "arguments": {"foo": "bar"}}\n</tool_call>\nDone.';
    const { clean, calls } = streamingView(text, ["test_tool"]);
    expect(clean).toBe("I will check.\n\nDone.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "test_tool",
      arguments: { foo: "bar" },
    });
  });

  it("ToolCallStreamParser streams clean text immediately while buffering tool call", () => {
    const parser = new ToolCallStreamParser(["get_weather"]);

    // Chunk 1: regular prose
    const delta1 = parser.feed("Checking weather for you... ");
    expect(delta1).toBe("Checking weather for you... ");
    expect(parser.drainCalls()).toEqual([]);

    // Chunk 2: partial marker opener
    const delta2 = parser.feed("<tool");
    expect(delta2).toBe(""); // held back!
    expect(parser.drainCalls()).toEqual([]);

    // Chunk 3: opener finished and part of body
    const delta3 = parser.feed('_call>\n{"name": "get_weather", "arguments":');
    expect(delta3).toBe(""); // still inside tool block
    expect(parser.drainCalls()).toEqual([]);

    // Chunk 4: body finished and closer
    const delta4 = parser.feed(' {"city": "Berlin"}}\n</tool_call>\nStand by!');
    expect(delta4).toBe("\nStand by!");
    const calls = parser.drainCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "get_weather", arguments: { city: "Berlin" } });

    // Finish
    const final = parser.finish();
    expect(final.text).toBe("");
    expect(final.calls).toEqual([]);
  });

  it("ToolCallStreamParser handles multiple parallel tool calls", () => {
    const parser = new ToolCallStreamParser(["tool_a", "tool_b"]);
    const text = '<tool_call>{"name": "tool_a", "arguments": {"x": 1}}</tool_call><tool_call>{"name": "tool_b", "arguments": {"y": 2}}</tool_call>';
    const delta = parser.feed(text);
    expect(delta).toBe("");
    const calls = parser.drainCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: "tool_a", arguments: { x: 1 } });
    expect(calls[1]).toMatchObject({ name: "tool_b", arguments: { y: 2 } });
  });

  it("ToolCallStreamParser strips undeclared tool calls and does not emit them", () => {
    const parser = new ToolCallStreamParser(["allowed_tool"]);
    const text = 'Here is the call:\n<tool_call>{"name": "forbidden_tool", "arguments": {}}</tool_call>\nAll done.';
    const delta = parser.feed(text);
    expect(delta).toBe("Here is the call:\n\nAll done.");
    expect(parser.drainCalls()).toEqual([]);
  });

  it("ToolCallStreamParser supports fenced and bracket syntaxes", () => {
    const fencedParser = new ToolCallStreamParser(["fenced_tool"]);
    fencedParser.feed('Fenced:\n```tool_call\n{"name": "fenced_tool", "arguments": {"a": 1}}\n```\nEnd');
    const fencedCalls = fencedParser.drainCalls();
    expect(fencedCalls).toHaveLength(1);
    expect(fencedCalls[0].name).toBe("fenced_tool");

    const bracketParser = new ToolCallStreamParser(["bracket_tool"]);
    bracketParser.feed('Bracket:\n[tool_call]\n{"name": "bracket_tool", "arguments": {"b": 2}}\n[/tool_call]\nEnd');
    const bracketCalls = bracketParser.drainCalls();
    expect(bracketCalls).toHaveLength(1);
    expect(bracketCalls[0].name).toBe("bracket_tool");
  });
});
