import { expect, test, describe, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROVIDERS, loadProviders, isUsable, tokenFor, UNSUPPORTED_NOTICE } from "../src/data/models/thirdParty.js";

const tmps: string[] = [];
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("providers", () => {
  test("ships the verified endpoints", () => {
    const kimi = BUILTIN_PROVIDERS.find((p) => p.id === "moonshot")!;
    expect(kimi.baseUrl).toBe("https://api.moonshot.ai/anthropic");
    expect(kimi.models).toContain("kimi-k2.5");
    expect(kimi.thirdParty).toBe(true);
  });
  test("Anthropic itself is not marked third-party", () => {
    expect(BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")!.thirdParty).toBe(false);
  });
  test("stores an env var NAME, never a literal key", () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p).not.toHaveProperty("authToken");
      if (p.thirdParty) expect(p.authTokenEnv).toMatch(/_API_KEY$/);
    }
  });
  test("a third-party provider is unusable without its key", () => {
    const kimi = BUILTIN_PROVIDERS.find((p) => p.id === "moonshot")!;
    delete process.env.MOONSHOT_API_KEY;
    expect(isUsable(kimi)).toBe(false);
    process.env.MOONSHOT_API_KEY = "test-key";
    expect(isUsable(kimi)).toBe(true);
    expect(tokenFor(kimi)).toBe("test-key");
    delete process.env.MOONSHOT_API_KEY;
  });
  test("Anthropic is always usable", () => {
    expect(isUsable(BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")!)).toBe(true);
  });
  test("a user file adds providers and overrides builtins by id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "th-")); tmps.push(dir);
    const p = join(dir, "providers.json");
    await writeFile(p, JSON.stringify([
      { id: "moonshot", label: "My Kimi", baseUrl: "https://custom", authTokenEnv: "K", models: ["kimi-k2.5"], thirdParty: true },
      { id: "local", label: "Ollama", baseUrl: "http://localhost:11434", authTokenEnv: "", models: ["llama"], thirdParty: true },
    ]));
    const list = await loadProviders(p);
    expect(list.find((x) => x.id === "moonshot")!.baseUrl).toBe("https://custom"); // overridden
    expect(list.find((x) => x.id === "local")).toBeTruthy();                        // added
    expect(list.find((x) => x.id === "anthropic")).toBeTruthy();                    // builtin kept
  });
  test("falls back to builtins when the file is missing or corrupt", async () => {
    expect(await loadProviders("/nonexistent/providers.json")).toEqual(BUILTIN_PROVIDERS);
  });
  test("quotes Anthropic's own wording rather than paraphrasing", () => {
    expect(UNSUPPORTED_NOTICE).toContain("doesn't endorse, maintain, or audit");
  });
});
