import { expect, test, describe } from "bun:test";
import { statusText } from "../src/panes/StatusBar.tsx";
import { emptyTotals } from "../src/data/usage.ts";

const usage = (over = {}) => ({ ...emptyTotals(), ...over });

describe("statusText", () => {
  test("hides dollars on a subscription (apiKeySource none)", () => {
    const s = statusText({ model: "claude-opus-5", phase: "idle", agents: 0,
      apiKeySource: "none", usage: usage({ inputTokens: 900, costUSD: 0.16 }) });
    expect(s).not.toContain("$");
    expect(s).toContain("subscription");
  });
  test("shows dollars when an API key is the billing path", () => {
    const s = statusText({ model: "claude-opus-5", phase: "idle", agents: 0,
      apiKeySource: "ANTHROPIC_API_KEY", usage: usage({ inputTokens: 900, costUSD: 0.1234 }) });
    expect(s).toContain("$0.1234");
  });
  test("hides dollars on a third-party provider even with a key", () => {
    const s = statusText({ model: "kimi-k2.5", phase: "idle", agents: 0, thirdParty: true,
      apiKeySource: "ANTHROPIC_API_KEY", usage: usage({ costUSD: 9.99 }) });
    expect(s).not.toContain("$");
  });
  test("reports cache hit ratio", () => {
    const s = statusText({ phase: "idle", agents: 0,
      usage: usage({ inputTokens: 100, cacheReadTokens: 900 }) });
    expect(s).toContain("cache 90%");
  });
  test("includes agent count only when non-zero", () => {
    expect(statusText({ phase: "idle", agents: 0, usage: usage() })).not.toContain("agents");
    expect(statusText({ phase: "idle", agents: 4, usage: usage() })).toContain("4 agents");
  });
  test("tolerates a missing model", () => {
    expect(statusText({ phase: "starting", agents: 0, usage: usage() })).toContain("—");
  });
});
