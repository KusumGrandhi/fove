/**
 * A phase that never returns must not wait forever.
 *
 * The budget caps *usage*, which is a different thing: a `claude` that hangs
 * without producing tokens costs nothing, so the budget never trips. Before
 * this, the UI showed "planning" indefinitely with no way to tell a hung run
 * from an honest one -- and honest ones genuinely take minutes, so "it is
 * still going" is not evidence either way.
 *
 * The runner spawns `claude` by name, so these tests put a fake one first on
 * PATH rather than calling the real CLI: the behaviour under test is the
 * timeout, not the model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffRunner } from "../src/main/handoffRunner.js";

let bin: string;
let repo: string;
let originalPath: string | undefined;

/** Put a fake `claude` on PATH that behaves however the test needs. */
function fakeClaude(body: string): void {
  const p = join(bin, "claude");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "fove-bin-"));
  repo = mkdtempSync(join(tmpdir(), "fove-repo-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("a phase that hangs", () => {
  it("is killed, and says so rather than reporting a plan", async () => {
    fakeClaude("sleep 30");

    const started = Date.now();
    const r = await new HandoffRunner().plan("do a thing", [], {
      cwd: repo, budgetUSD: 5, timeoutMs: 300,
    });

    expect(r.plan).toBeUndefined();
    expect(r.error).toMatch(/no result after/);
    // Killed near the deadline, not after the sleep.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills execute too, not only planning", async () => {
    fakeClaude("sleep 30");

    const r = await new HandoffRunner().execute(
      { summary: "s", steps: [{ n: 1, action: "a" }] },
      { cwd: repo, budgetUSD: 5, timeoutMs: 300 },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no result after/);
  });
});

describe("stopping", () => {
  it("kills the whole tree, so `stop` actually stops it", async () => {
    /*
     * `claude` spawns children. Signalling only the parent leaves them
     * running and holding the stdio pipes open, so the promise never settles
     * -- the stop button would report nothing and the work would continue.
     */
    fakeClaude("sleep 30");
    const abort = new AbortController();

    const started = Date.now();
    const p = new HandoffRunner().plan("do a thing", [], {
      cwd: repo, budgetUSD: 5, signal: abort.signal, timeoutMs: 60_000,
    });
    setTimeout(() => abort.abort(), 150);

    const r = await p;
    expect(r.plan).toBeUndefined();
    // Settled because of the abort, long before the sleep or the timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("a phase that finishes in time", () => {
  it("is not affected by the timeout", async () => {
    /*
     * The ceiling must never truncate honest work -- planning a real ticket
     * takes minutes, and a timeout firing during it would be worse than none.
     */
    const result = {
      is_error: false,
      structured_output: { summary: "the plan", steps: [{ n: 1, action: "edit" }] },
      total_cost_usd: 0.12,
      session_id: "s1",
    };
    fakeClaude(`cat <<'JSON'\n${JSON.stringify(result)}\nJSON`);

    const r = await new HandoffRunner().plan("do a thing", [], {
      cwd: repo, budgetUSD: 5, timeoutMs: 10_000,
    });

    expect(r.plan?.summary).toBe("the plan");
    expect(r.costUSD).toBeCloseTo(0.12, 3);
    expect(r.error).toBeUndefined();
  });
});
