import { expect, test, describe, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDefaultModel, saveDefaultModel, DEFAULT_MODEL_PATH,
} from "../src/data/models/defaultModel.js";

const tmps: string[] = [];
async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fove-def-"));
  tmps.push(dir);
  return join(dir, "default-model.json");
}
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("default model", () => {
  test("round-trips a provider and model", async () => {
    const path = await file();
    await saveDefaultModel({ providerId: "openrouter", model: "openai/gpt-5" }, path);
    expect(await loadDefaultModel(path)).toEqual({ providerId: "openrouter", model: "openai/gpt-5" });
  });

  test("an empty model means the provider's own default", async () => {
    const path = await file();
    await saveDefaultModel({ providerId: "anthropic", model: "" }, path);
    expect(await loadDefaultModel(path)).toEqual({ providerId: "anthropic", model: "" });
  });

  test("clearing removes the file rather than leaving a stale one", async () => {
    const path = await file();
    await saveDefaultModel({ providerId: "openrouter", model: "openai/gpt-5" }, path);
    await saveDefaultModel(null, path);
    expect(await loadDefaultModel(path)).toBeNull();
    await expect(access(path)).rejects.toThrow();
  });

  test("no default is null, not a crash", async () => {
    expect(await loadDefaultModel("/nonexistent/default-model.json")).toBeNull();
  });

  test("a corrupt or incomplete file falls back to no default", async () => {
    const path = await file();
    await writeFile(path, "{ not json");
    expect(await loadDefaultModel(path)).toBeNull();
    await writeFile(path, JSON.stringify({ model: "openai/gpt-5" }));
    expect(await loadDefaultModel(path)).toBeNull();
  });

  test("never stores a key, only which backend to use", async () => {
    const path = await file();
    await saveDefaultModel({ providerId: "openrouter", model: "openai/gpt-5" }, path);
    const saved = await loadDefaultModel(path);
    expect(Object.keys(saved!).sort()).toEqual(["model", "providerId"]);
  });

  test("lives under fove, never in ~/.claude", () => {
    expect(DEFAULT_MODEL_PATH).toContain("/.config/fove/");
    expect(DEFAULT_MODEL_PATH).not.toContain(".claude");
  });
});
