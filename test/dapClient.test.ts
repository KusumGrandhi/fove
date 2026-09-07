/**
 * The DAP client, against a fake adapter.
 *
 * The plan names the risk plainly: a debugger is a stateful protocol against a
 * live process, so "read it again" is not a recovery strategy. These tests
 * exist to pin the failure paths -- timeout, disconnect, out-of-order reply --
 * without needing debugpy, a port, or a process.
 */

import { describe, expect, it, vi } from "vitest";
import { DapClient } from "../src/main/dapClient.js";
import { DapDecoder, encode, type DapMessage } from "../src/shared/dap.js";

/**
 * A fake adapter on the other end of the wire.
 *
 * It decodes what the client writes and lets a test answer it however the
 * scenario needs: out of order, not at all, or with a failure.
 */
function fake() {
  const decoder = new DapDecoder();
  const seen: DapMessage[] = [];
  let client!: DapClient;

  client = new DapClient((data) => {
    for (const msg of decoder.push(data)) seen.push(msg);
  });

  return {
    client,
    seen,
    /** Reply to the request with the given seq. */
    reply(requestSeq: number, body?: unknown, success = true, message?: string) {
      client.feed(encode({
        type: "response", request_seq: requestSeq, success, body, message,
      } as DapMessage));
    },
    /** Send an unsolicited event, as a real adapter does when it stops. */
    event(name: string, body?: unknown) {
      client.feed(encode({ type: "event", event: name, body }));
    },
  };
}

describe("DapClient", () => {
  it("sends a request with an increasing seq", async () => {
    const f = fake();
    void f.client.request("initialize");
    void f.client.request("launch");
    expect(f.seen.map((m) => m.command)).toEqual(["initialize", "launch"]);
    expect(f.seen[0]!.seq).toBe(1);
    expect(f.seen[1]!.seq).toBe(2);
  });

  it("resolves a request with its response body", async () => {
    const f = fake();
    const p = f.client.request("stackTrace");
    f.reply(1, { stackFrames: [{ id: 7, name: "handler" }] });
    const r = await p;
    expect(r.success).toBe(true);
    expect((r.body as { stackFrames: unknown[] }).stackFrames).toHaveLength(1);
  });

  it("matches responses to requests when they arrive out of order", async () => {
    // A real adapter answers a slow request after a fast one issued later.
    const f = fake();
    const first = f.client.request("stackTrace");
    const second = f.client.request("threads");
    f.reply(2, { threads: [] });
    f.reply(1, { stackFrames: [] });
    expect((await second).body).toEqual({ threads: [] });
    expect((await first).body).toEqual({ stackFrames: [] });
  });

  it("resolves rather than rejects when the adapter reports failure", async () => {
    // "cannot evaluate in this frame" is an ordinary outcome to display.
    const f = fake();
    const p = f.client.request("evaluate");
    f.reply(1, undefined, false, "not available");
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.message).toBe("not available");
  });

  it("times out instead of hanging the UI forever", async () => {
    vi.useFakeTimers();
    const f = fake();
    const p = f.client.request("stackTrace", undefined, 1000);
    vi.advanceTimersByTime(1001);
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.message).toContain("timed out");
    vi.useRealTimers();
  });

  it("ignores a response that arrives after its request timed out", async () => {
    vi.useFakeTimers();
    const f = fake();
    const p = f.client.request("stackTrace", undefined, 1000);
    vi.advanceTimersByTime(1001);
    await p;
    // Must not throw or resolve anything a second time.
    expect(() => f.reply(1, { late: true })).not.toThrow();
    vi.useRealTimers();
  });

  it("settles every in-flight request when the session ends", async () => {
    // The process being debugged exiting is normal, not exceptional -- but a
    // promise left pending would wedge the pane waiting for it.
    const f = fake();
    const a = f.client.request("stackTrace");
    const b = f.client.request("variables");
    f.client.close("process exited");
    expect((await a).message).toBe("process exited");
    expect((await b).message).toBe("process exited");
  });

  it("refuses new requests once closed", async () => {
    const f = fake();
    f.client.close();
    const r = await f.client.request("threads");
    expect(r.success).toBe(false);
    expect(f.seen).toHaveLength(0);
  });

  it("delivers events to subscribers", () => {
    const f = fake();
    const stops: unknown[] = [];
    f.client.on("stopped", (b) => stops.push(b));
    f.event("stopped", { reason: "breakpoint", threadId: 1 });
    expect(stops).toEqual([{ reason: "breakpoint", threadId: 1 }]);
  });

  it("stops delivering after unsubscribe", () => {
    const f = fake();
    const seen: unknown[] = [];
    const off = f.client.on("output", (b) => seen.push(b));
    f.event("output", { output: "a" });
    off();
    f.event("output", { output: "b" });
    expect(seen).toHaveLength(1);
  });

  it("keeps notifying other listeners when one throws", () => {
    // A render error in one subscriber must not silently stop the debugger.
    const f = fake();
    const seen: unknown[] = [];
    f.client.on("stopped", () => { throw new Error("boom"); });
    f.client.on("stopped", (b) => seen.push(b));
    f.event("stopped", { reason: "step" });
    expect(seen).toHaveLength(1);
  });

  it("survives a write that throws", async () => {
    // The socket can die between the check and the write.
    const client = new DapClient(() => { throw new Error("EPIPE"); });
    const r = await client.request("threads");
    expect(r.success).toBe(false);
    expect(r.message).toBe("EPIPE");
  });

  it("ignores an event with no listeners", () => {
    const f = fake();
    expect(() => f.event("continued", {})).not.toThrow();
  });

  it("is safe to close twice", () => {
    const f = fake();
    f.client.close();
    expect(() => f.client.close()).not.toThrow();
    expect(f.client.isClosed).toBe(true);
  });

  it("handles a response split across two reads", async () => {
    // The transport boundary case, end to end through the client.
    const f = fake();
    const p = f.client.request("threads");
    const whole = encode({ type: "response", request_seq: 1, success: true, body: { threads: [] } } as DapMessage);
    f.client.feed(whole.subarray(0, 12));
    f.client.feed(whole.subarray(12));
    expect((await p).success).toBe(true);
  });
});
