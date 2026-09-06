import { expect, test, describe } from "vitest";
import { UsageAccumulator, cacheHitRatio, costIsMeaningful, formatTokens, totalTokens } from "../src/data/usage.js";

describe("UsageAccumulator", () => {
  test("modelUsage is the whole-tree source and marks totals accordingly", () => {
    const a = new UsageAccumulator();
    expect(a.current.wholeTree).toBe(false);
    a.addResult({
      "claude-opus-5":  { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
      "claude-fable-5": { inputTokens: 900, outputTokens: 20, costUSD: 0.02 },
    });
    expect(a.current.wholeTree).toBe(true);
    expect(a.current.inputTokens).toBe(1000);   // includes the subagent model
    expect(a.current.outputTokens).toBe(70);
    expect(a.current.byModel.size).toBe(2);
  });

  test("prefers the reported call total over the per-model sum", () => {
    const a = new UsageAccumulator();
    a.addResult({ m: { costUSD: 0.01 } }, 0.05); // billing rules the sum misses
    expect(a.current.costUSD).toBe(0.05);
  });

  test("per-step usage dedupes by message id and ignores placeholder output", () => {
    const a = new UsageAccumulator();
    const u = { input_tokens: 10, output_tokens: 999, cache_read_input_tokens: 5 };
    a.addStep("m1", u);
    a.addStep("m1", u);   // parallel tool call, same id
    a.addStep("m2", u);
    expect(a.current.inputTokens).toBe(20);      // counted twice, not three times
    expect(a.current.cacheReadTokens).toBe(10);
    expect(a.current.outputTokens).toBe(0);      // placeholder never trusted
  });

  test("streaming output only ever increases", () => {
    const a = new UsageAccumulator();
    a.setStreamingOutput(50);
    a.setStreamingOutput(30);  // a late/stale delta must not regress the count
    expect(a.current.outputTokens).toBe(50);
  });

  test("counts a failed turn's tokens", () => {
    const a = new UsageAccumulator();
    a.addResult({ m: { inputTokens: 500, costUSD: 0.003 } }, 0.003);
    expect(a.current.inputTokens).toBe(500);
  });
});

describe("helpers", () => {
  test("totalTokens sums every billed category", () => {
    expect(totalTokens({ input_tokens: 2, cache_creation_input_tokens: 25818,
                         cache_read_input_tokens: 100, output_tokens: 5 })).toBe(25925);
  });
  test("cacheHitRatio", () => {
    expect(cacheHitRatio({ cache_read_input_tokens: 90, input_tokens: 10 })).toBeCloseTo(0.9);
    expect(cacheHitRatio({})).toBeUndefined();
  });
  test("cost is hidden on subscriptions and third-party endpoints", () => {
    expect(costIsMeaningful({ usingApiKey: true,  thirdPartyProvider: false })).toBe(true);
    expect(costIsMeaningful({ usingApiKey: false, thirdPartyProvider: false })).toBe(false);
    expect(costIsMeaningful({ usingApiKey: true,  thirdPartyProvider: true  })).toBe(false);
  });
  test("formatTokens", () => {
    expect(formatTokens(827075)).toBe("827.1k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(42)).toBe("42");
  });
});

describe("output tokens in transcripts with no result record", () => {
  const usage = (o: Partial<Record<string, number>>) => ({
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o,
  });

  test("a CLI transcript still reports output -- the reason the panel read 0", () => {
    // No addResult(): modelUsage appears zero times in a real CLI transcript.
    const u = new UsageAccumulator();
    u.addStep("msg_a", usage({ input_tokens: 2, output_tokens: 994 }));
    u.addStep("msg_b", usage({ input_tokens: 3, output_tokens: 1016 }));
    u.settle();
    expect(u.totals.outputTokens).toBe(2010);
  });

  test("a repeated message id is counted once -- parallel tool calls repeat it", () => {
    const u = new UsageAccumulator();
    u.addStep("msg_a", usage({ output_tokens: 994 }));
    u.addStep("msg_a", usage({ output_tokens: 994 }));
    u.addStep("msg_a", usage({ output_tokens: 994 }));
    u.settle();
    expect(u.totals.outputTokens).toBe(994);
  });

  test("an authoritative modelUsage figure is never inflated by per-step counts", () => {
    const u = new UsageAccumulator();
    u.addStep("msg_a", usage({ output_tokens: 994 }));
    u.addResult({ "claude-opus-5": {
      inputTokens: 10, outputTokens: 5000,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1,
    } });
    u.settle();
    // The result message wins outright; the placeholder is discarded.
    expect(u.totals.outputTokens).toBe(5000);
    expect(u.totals.wholeTree).toBe(true);
  });

  test("settle is idempotent", () => {
    const u = new UsageAccumulator();
    u.addStep("msg_a", usage({ output_tokens: 100 }));
    u.settle(); u.settle(); u.settle();
    expect(u.totals.outputTokens).toBe(100);
  });

  test("input and cache totals are unaffected", () => {
    const u = new UsageAccumulator();
    u.addStep("msg_a", usage({
      input_tokens: 2, output_tokens: 994,
      cache_read_input_tokens: 57028, cache_creation_input_tokens: 1062,
    }));
    u.settle();
    expect(u.totals.inputTokens).toBe(2);
    expect(u.totals.cacheReadTokens).toBe(57028);
    expect(u.totals.cacheCreationTokens).toBe(1062);
  });
});
