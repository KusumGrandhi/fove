/**
 * Window occupancy: the number the stats rail leads with.
 *
 * Two halves, tested together because either one alone gives a wrong bar --
 * the numerator comes off the last main-loop turn, the denominator out of the
 * bundled model table.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindowFor } from "../src/data/models/contextWindow.js";
import { replaySession } from "../src/data/replay.js";
import type { SessionSummary } from "../src/data/types.js";

describe("contextWindowFor", () => {
  test("the long-context variant wins over the base id", () => {
    // claude-opus-4-5 is a 200k model; the suffix is how the CLI names the
    // session that was opened on the million-token variant.
    expect(contextWindowFor("claude-opus-4-5[1m]")).toEqual({ limit: 1_000_000, known: true });
    expect(contextWindowFor("claude-opus-4-5")).toEqual({ limit: 200_000, known: true });
  });

  test("reads through dated snapshots and vendor prefixes", () => {
    expect(contextWindowFor("claude-opus-4-5-20251101").limit).toBe(200_000);
    expect(contextWindowFor("anthropic.claude-opus-5").limit).toBe(1_000_000);
    expect(contextWindowFor("claude-haiku-4-5-20251001").limit).toBe(200_000);
  });

  test("an unrecognised model reports the fallback as a guess", () => {
    // An OpenRouter pane, or a model released after this table was written.
    // The rail says so rather than drawing a confident bar.
    expect(contextWindowFor("qwen/qwen3-coder")).toEqual({ limit: 200_000, known: false });
    expect(contextWindowFor(undefined).known).toBe(false);
  });
});

describe("replaySession context", () => {
  let dir: string;
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const summaryFor = (path: string): SessionSummary => ({
    sessionId: "ctx", projectSlug: "p", path, sizeBytes: 0, mtimeMs: 0,
  });

  const assistant = (
    usage: Record<string, number>,
    extra: Record<string, unknown> = {},
  ) => line({
    type: "assistant",
    timestamp: "2026-09-16T10:00:00.000Z",
    message: { id: `m${Math.random()}`, model: "claude-opus-5", usage },
    ...extra,
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fove-ctx-"));
    await mkdir(dir, { recursive: true });
  });

  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("reports the newest main-loop turn, not the sum of every turn", async () => {
    const p = join(dir, "a.jsonl");
    await writeFile(p,
      assistant({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 }) +
      assistant({ input_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 7 }));

    const r = await replaySession(summaryFor(p));
    // The window holds what the last turn sent -- 3027, not 4042 accumulated.
    expect(r.context).toMatchObject({
      inputTokens: 20, cacheReadTokens: 3000, cacheCreationTokens: 7, totalTokens: 3027,
      model: "claude-opus-5",
    });
    // Totals still accumulate: the two numbers answer different questions.
    expect(r.usage.current.cacheReadTokens).toBe(4000);
  });

  test("a subagent's turn is not the main loop's context", async () => {
    const p = join(dir, "b.jsonl");
    await writeFile(p,
      assistant({ input_tokens: 20, cache_read_input_tokens: 3000 }) +
      // A sidechain record is the subagent's own request against its own
      // window; counting it here would report a 5k pane as a 60k one.
      assistant({ input_tokens: 5, cache_read_input_tokens: 60_000 }, { isSidechain: true }));

    const r = await replaySession(summaryFor(p));
    expect(r.context?.totalTokens).toBe(3020);
  });

  test("a record carrying no prompt figures leaves the last reading standing", async () => {
    const p = join(dir, "c.jsonl");
    await writeFile(p,
      assistant({ input_tokens: 20, cache_read_input_tokens: 3000 }) +
      assistant({ output_tokens: 40 }));  // streaming stub, no prompt counts

    const r = await replaySession(summaryFor(p));
    expect(r.context?.totalTokens).toBe(3020);
  });

  test("a session with no assistant turn has no context to report", async () => {
    const p = join(dir, "d.jsonl");
    await writeFile(p, line({ type: "user", message: { content: "hello" } }));

    const r = await replaySession(summaryFor(p));
    // Absent, not zero: "not started" and "0% full" are different states.
    expect(r.context).toBeUndefined();
  });
});
