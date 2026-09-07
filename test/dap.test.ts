/**
 * The DAP wire format.
 *
 * Tested hard because a debug session is stateful against a live process: a
 * misframed message desynchronises the session rather than failing a request
 * that could simply be retried.
 */

import { describe, expect, it } from "vitest";
import { DapDecoder, contentLength, encode, type DapMessage } from "../src/shared/dap.js";

const frame = (json: string): Buffer =>
  Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`, "ascii"),
    Buffer.from(json, "utf8"),
  ]);

describe("contentLength", () => {
  it("reads the length", () => {
    expect(contentLength("Content-Length: 42")).toBe(42);
  });

  it("is case insensitive, as the header name is", () => {
    expect(contentLength("content-length: 7")).toBe(7);
  });

  it("ignores other headers alongside it", () => {
    expect(contentLength("Content-Type: application/json\r\nContent-Length: 9")).toBe(9);
  });

  it("returns null when absent", () => {
    expect(contentLength("Content-Type: text/plain")).toBeNull();
  });

  it("rejects a non-numeric length rather than guessing", () => {
    expect(contentLength("Content-Length: abc")).toBeNull();
  });

  it("rejects a negative length", () => {
    expect(contentLength("Content-Length: -1")).toBeNull();
  });
});

describe("encode", () => {
  it("counts bytes, not characters", () => {
    // The bug this guards: "é" is one character but two bytes. A header built
    // from string length truncates the body and desyncs every later frame.
    const buf = encode({ type: "event", event: "output", body: { output: "é" } });
    const header = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString("ascii");
    const declared = contentLength(header)!;
    const bodyBytes = buf.length - buf.indexOf("\r\n\r\n") - 4;
    expect(declared).toBe(bodyBytes);
  });

  it("round-trips through the decoder", () => {
    const msg: DapMessage = { seq: 1, type: "request", command: "initialize" };
    expect(new DapDecoder().push(encode(msg))).toEqual([msg]);
  });
});

describe("DapDecoder", () => {
  it("decodes one whole message", () => {
    const out = new DapDecoder().push(frame('{"type":"event","event":"initialized"}'));
    expect(out).toEqual([{ type: "event", event: "initialized" }]);
  });

  it("decodes several messages arriving in one read", () => {
    // TCP coalesces writes; a per-chunk parser would see only the first.
    const d = new DapDecoder();
    const out = d.push(Buffer.concat([
      frame('{"type":"event","event":"a"}'),
      frame('{"type":"event","event":"b"}'),
    ]));
    expect(out.map((m) => m.event)).toEqual(["a", "b"]);
  });

  it("waits for a body that has not fully arrived", () => {
    const d = new DapDecoder();
    const whole = frame('{"type":"event","event":"initialized"}');
    expect(d.push(whole.subarray(0, whole.length - 5))).toEqual([]);
    expect(d.push(whole.subarray(whole.length - 5))).toEqual([
      { type: "event", event: "initialized" },
    ]);
  });

  it("waits for a header split mid-word", () => {
    // A read can land anywhere, including inside "Content-Length".
    const d = new DapDecoder();
    const whole = frame('{"type":"event","event":"x"}');
    expect(d.push(whole.subarray(0, 7))).toEqual([]);
    expect(d.push(whole.subarray(7))).toEqual([{ type: "event", event: "x" }]);
  });

  it("handles a body split inside a multi-byte character", () => {
    // The split lands mid-UTF-8: decoding per chunk would produce U+FFFD.
    const d = new DapDecoder();
    const whole = frame('{"type":"event","event":"é"}');
    const at = whole.length - 3;
    expect(d.push(whole.subarray(0, at))).toEqual([]);
    expect(d.push(whole.subarray(at))).toEqual([{ type: "event", event: "é" }]);
  });

  it("keeps a byte-accurate length for a non-ASCII body", () => {
    const d = new DapDecoder();
    const out = d.push(Buffer.concat([
      frame('{"type":"event","event":"é","body":{"p":"/tmp/café/a.py"}}'),
      frame('{"type":"event","event":"after"}'),
    ]));
    // If the first frame's length were counted in characters, the second
    // message would be consumed as part of the first and lost.
    expect(out.map((m) => m.event)).toEqual(["é", "after"]);
  });

  it("skips a malformed body without desyncing the stream", () => {
    const d = new DapDecoder();
    const out = d.push(Buffer.concat([
      frame("{not json}"),
      frame('{"type":"event","event":"after"}'),
    ]));
    expect(out.map((m) => m.event)).toEqual(["after"]);
  });

  it("resyncs past a header with no Content-Length", () => {
    const d = new DapDecoder();
    const out = d.push(Buffer.concat([
      Buffer.from("Content-Type: application/json\r\n\r\n", "ascii"),
      frame('{"type":"event","event":"after"}'),
    ]));
    expect(out.map((m) => m.event)).toEqual(["after"]);
  });

  it("reports nothing pending once a frame is consumed", () => {
    const d = new DapDecoder();
    d.push(frame('{"type":"event","event":"x"}'));
    expect(d.pending).toBe(0);
  });

  it("retains a partial frame as pending", () => {
    const d = new DapDecoder();
    const whole = frame('{"type":"event","event":"x"}');
    d.push(whole.subarray(0, 10));
    expect(d.pending).toBe(10);
  });

  it("handles an empty chunk", () => {
    expect(new DapDecoder().push(Buffer.alloc(0))).toEqual([]);
  });

  it("decodes a stream fed one byte at a time", () => {
    // The strongest form of the boundary test.
    const d = new DapDecoder();
    const whole = frame('{"type":"event","event":"drip"}');
    const out: DapMessage[] = [];
    for (const byte of whole) out.push(...d.push(Buffer.from([byte])));
    expect(out.map((m) => m.event)).toEqual(["drip"]);
  });
});
