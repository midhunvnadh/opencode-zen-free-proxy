import { describe, expect, it } from "vitest";
import { HttpError, basicAuth, describeError, pump, randomHex, rid } from "../src/lib.ts";

describe("HttpError", () => {
  it("defaults to an upstream error and keeps an explicit type", () => {
    expect(new HttpError(429, "slow down").type).toBe("upstream_error");
    expect(new HttpError(400, "bad", "invalid_request_error").type).toBe("invalid_request_error");
    expect(new HttpError(400, "bad")).toBeInstanceOf(Error);
  });
});

describe("describeError", () => {
  it("passes an HttpError through untouched", () => {
    expect(describeError(new HttpError(401, "nope"))).toEqual({
      status: 401,
      type: "upstream_error",
      message: "nope",
    });
  });

  it("turns anything else into an HttpError at the fallback status", () => {
    expect(describeError(new Error("boom"))).toMatchObject({ status: 502, message: "boom" });
    expect(describeError("plain string")).toMatchObject({ status: 502, message: "plain string" });
    expect(describeError(new Error("inner"), 500)).toMatchObject({ status: 500 });
  });
});

describe("ids", () => {
  it("renders hex of the requested byte length", () => {
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomHex()).toMatch(/^[0-9a-f]{24}$/);
    expect(randomHex()).not.toBe(randomHex());
  });

  it("prefixes ids", () => {
    expect(rid("msg_")).toMatch(/^msg_[0-9a-f]{24}$/);
  });
});

describe("basicAuth", () => {
  it("encodes UTF-8 credentials the way RFC 7617 requires", () => {
    // btoa() alone throws on anything above U+00FF, which is why the password is
    // encoded to bytes first.
    expect(basicAuth("opencode", "oc-1234")).toBe("Basic b3BlbmNvZGU6b2MtMTIzNA==");
    expect(() => basicAuth("opencode", "pässwörd")).not.toThrow();
    expect(Buffer.from(basicAuth("opencode", "pässwörd").slice(6), "base64").toString()).toBe(
      "opencode:pässwörd"
    );
  });
});

describe("pump", () => {
  const streamOf = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });

  it("reads a stream to the end, decoding multi-byte characters split across chunks", async () => {
    const seen: string[] = [];
    await pump(streamOf("héllo ", "wor"), (t) => seen.push(t));
    expect(seen.join("")).toBe("héllo wor");
  });

  it("swallows a stream that errors, because callers stop reading by closing it", async () => {
    const seen: string[] = [];
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull(controller) {
        controller.error(new Error("aborted"));
      },
    });
    await expect(pump(broken, (t) => seen.push(t))).resolves.toBeUndefined();
    expect(seen.join("")).toBe("partial");
  });
});
