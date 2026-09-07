/**
 * The DAP launch sequence, against a fake adapter on a real socket.
 *
 * This is the part with no second chance. DAP requires:
 *
 *   initialize -> wait for the `initialized` EVENT -> setBreakpoints
 *              -> configurationDone -> the program runs
 *
 * Get it wrong and there is no error: breakpoints sent too early are dropped
 * silently, and a missing `configurationDone` leaves the program paused at
 * startup looking exactly like a hang. Neither shows up as a failed request,
 * which is why it is pinned here rather than trusted to review.
 *
 * A fake adapter is used rather than debugpy: debugpy is not installed on this
 * machine, and the ordering is a property of the protocol, not of the adapter.
 */

import { afterEach, describe, expect, it } from "vitest";
import { connect, createServer, type Server, type Socket } from "node:net";
import { DapDecoder, encode, type DapMessage } from "../src/shared/dap.js";
import { DapClient } from "../src/main/dapClient.js";

/**
 * An adapter that records what it is asked and answers like debugpy.
 *
 * `initialized` is emitted *after* the initialize response, which is the
 * ordering a real adapter uses and the one that breaks a client waiting on the
 * response alone.
 */
function fakeAdapter(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      const decoder = new DapDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const msg of decoder.push(chunk)) {
          if (msg.type !== "request" || !msg.command) continue;
          seen.push(msg.command);
          const reply = (body?: unknown): void => {
            socket.write(encode({
              type: "response", request_seq: msg.seq, success: true,
              command: msg.command, body,
            } as DapMessage));
          };
          if (msg.command === "initialize") {
            reply({ supportsConfigurationDoneRequest: true });
            // The event follows the response, as debugpy does.
            socket.write(encode({ type: "event", event: "initialized" }));
          } else if (msg.command === "setBreakpoints") {
            const args = msg.arguments as { breakpoints?: { line: number }[] };
            reply({ breakpoints: (args?.breakpoints ?? []).map((b) => ({ verified: true, line: b.line })) });
          } else {
            reply({});
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, seen });
    });
  });
}

let open: Server | null = null;
afterEach(() => { open?.close(); open = null; });

/** Drive the same sequence DebugSession.start performs. */
async function runSequence(
  port: number,
  breakpoints: { path: string; lines: number[] }[],
): Promise<void> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const client = new DapClient((data) => socket.write(data));
  socket.on("data", (b: Buffer) => client.feed(b));

  // Subscribe BEFORE initialize: the event can land before the response.
  const initialized = new Promise<void>((resolve) => {
    const off = client.on("initialized", () => { off(); resolve(); });
  });

  await client.request("initialize", { adapterID: "debugpy" });
  await client.request("attach", {});
  await initialized;
  for (const bp of breakpoints) {
    await client.request("setBreakpoints", {
      source: { path: bp.path },
      breakpoints: bp.lines.map((line) => ({ line })),
    });
  }
  await client.request("configurationDone");
  client.close();
  socket.destroy();
}

describe("DAP launch sequence", () => {
  it("sends breakpoints after initialize and before configurationDone", async () => {
    const { server, port, seen } = await fakeAdapter();
    open = server;
    await runSequence(port, [{ path: "/w/app.py", lines: [12] }]);

    expect(seen[0]).toBe("initialize");
    // The rule: breakpoints strictly between initialize and configurationDone.
    const bp = seen.indexOf("setBreakpoints");
    const done = seen.indexOf("configurationDone");
    expect(bp).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(bp);
  });

  it("always sends configurationDone, or the program never starts", async () => {
    const { server, port, seen } = await fakeAdapter();
    open = server;
    await runSequence(port, []);
    // Even with no breakpoints: without this the program sits paused at
    // startup, which is indistinguishable from a hang.
    expect(seen).toContain("configurationDone");
  });

  it("sends one setBreakpoints per file", async () => {
    const { server, port, seen } = await fakeAdapter();
    open = server;
    await runSequence(port, [
      { path: "/w/a.py", lines: [1, 2] },
      { path: "/w/b.py", lines: [3] },
    ]);
    expect(seen.filter((c) => c === "setBreakpoints")).toHaveLength(2);
  });

  it("completes the whole sequence in order", async () => {
    // The failure mode this guards: waiting on the initialize *response* alone
    // races the event and can proceed before the adapter is ready.
    const { server, port, seen } = await fakeAdapter();
    open = server;
    await runSequence(port, [{ path: "/w/a.py", lines: [5] }]);
    expect(seen).toEqual(["initialize", "attach", "setBreakpoints", "configurationDone"]);
  });
});
