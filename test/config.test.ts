import { expect, test, describe, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, REDACTED } from "../src/data/config/claudeJson.js";
import { parseFrontmatter, sortSkills, budget, estTokens, orphanUsage, type SkillInfo } from "../src/data/config/skills.js";
import { readSettings, setSkillOverride, nextOverride } from "../src/data/config/settingsFile.js";

const tmps: string[] = [];
const mk = async () => { const d = await mkdtemp(join(tmpdir(), "th-")); tmps.push(d); return d; };
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("redact", () => {
  test("masks tokens by value shape", () => {
    expect(redact("ghp_abc123def456")).toBe(REDACTED);
    expect(redact("Bearer eyJhbGci")).toBe(REDACTED);
    expect(redact("Basic cGs6c2s=")).toBe(REDACTED);
    expect(redact("sk-ant-api03-xyz")).toBe(REDACTED);
  });
  test("masks by key name even when the value looks ordinary", () => {
    const out = redact({ Authorization: "abcdefghijk" }, "") as Record<string, unknown>;
    expect(out.Authorization).toBe(REDACTED);
  });
  test("leaves ordinary values alone", () => {
    expect(redact("https://api.example.com")).toBe("https://api.example.com");
    expect(redact(42)).toBe(42);
  });
  test("recurses through nested objects and arrays", () => {
    const out = redact({ a: { headers: { Authorization: "Bearer x" } }, b: ["ghp_zzzzzzzzz"] }) as any;
    expect(out.a.headers.Authorization).toBe(REDACTED);
    expect(out.b[0]).toBe(REDACTED);
  });
});

describe("parseFrontmatter", () => {
  test("measures the frontmatter block and extracts the description", () => {
    const md = "---\nname: x\ndescription: Does a thing\n---\n\nBody text here";
    const r = parseFrontmatter(md);
    expect(r.description).toBe("Does a thing");
    expect(r.bytes).toBeGreaterThan(0);
    // Cost is the frontmatter only -- the body loads on demand.
    expect(r.bytes).toBeLessThan(md.length);
  });
  test("handles a file with no frontmatter", () => {
    expect(parseFrontmatter("# Just markdown")).toEqual({ bytes: 0 });
  });
  test("strips surrounding quotes", () => {
    expect(parseFrontmatter('---\ndescription: "Quoted"\n---\n').description).toBe("Quoted");
  });
});

const skill = (over: Partial<SkillInfo>): SkillInfo => ({
  name: "s", path: "/p", frontmatterBytes: 100, usageCount: 0, ...over,
});

describe("sortSkills / budget", () => {
  const skills = [
    skill({ name: "cheap-loved", frontmatterBytes: 100, usageCount: 27 }),
    skill({ name: "dear-unused", frontmatterBytes: 1600, usageCount: 0 }),
    skill({ name: "dear-used",   frontmatterBytes: 1600, usageCount: 20 }),
  ];
  test("costPerUse ranks expensive-and-unused worst", () => {
    expect(sortSkills(skills, "costPerUse")[0]!.name).toBe("dear-unused");
  });
  test("an unused skill is not divided by zero", () => {
    expect(() => sortSkills([skill({ usageCount: 0 })], "costPerUse")).not.toThrow();
  });
  test("usage sorts by invocation count", () => {
    expect(sortSkills(skills, "usage")[0]!.name).toBe("cheap-loved");
  });
  test("budget counts only skills that reach the system prompt", () => {
    const withOff = [...skills, skill({ name: "off", frontmatterBytes: 5000, override: "off" })];
    expect(budget(withOff).bytes).toBe(3300);
    // user-invocable-only also leaves the model's listing.
    const withUio = [...skills, skill({ name: "u", frontmatterBytes: 5000, override: "user-invocable-only" })];
    expect(budget(withUio).bytes).toBe(3300);
  });
  test("estTokens approximates 4 chars per token", () => {
    expect(estTokens(23683)).toBe(5921);
  });
});

describe("orphanUsage", () => {
  test("surfaces used skills that are not on disk in the user dir", () => {
    const usage = new Map([["backend-testing", { usageCount: 16 }], ["known", { usageCount: 1 }]]);
    const out = orphanUsage([skill({ name: "known" })], usage);
    expect(out).toEqual([{ name: "backend-testing", usageCount: 16 }]);
  });
});

describe("settings writer", () => {
  test("round-trips without dropping unknown keys", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await writeFile(p, JSON.stringify({ effortLevel: "high", permissions: { allow: ["Bash"] } }));
    await setSkillOverride("noisy", "off", p);
    const after = await readSettings(p);
    expect(after.effortLevel).toBe("high");                   // preserved
    expect((after.permissions as any).allow).toEqual(["Bash"]); // preserved
    expect(after.skillOverrides).toEqual({ noisy: "off" });
  });
  test('"on" removes the entry rather than storing a default', async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await setSkillOverride("x", "off", p);
    await setSkillOverride("x", "on", p);
    expect((await readSettings(p)).skillOverrides).toBeUndefined();
  });
  test("preserves file mode", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await writeFile(p, "{}", { mode: 0o600 });
    await setSkillOverride("x", "off", p);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
  test("takes exactly one backup per path", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await writeFile(p, "{}");
    await setSkillOverride("a", "off", p);
    await setSkillOverride("b", "off", p);
    const baks = (await readdir(dir)).filter((f) => f.endsWith(".bak"));
    expect(baks).toHaveLength(1);
  });
  test("creates a settings file when none exists", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await setSkillOverride("x", "off", p);
    expect((await readSettings(p)).skillOverrides).toEqual({ x: "off" });
  });
  test("leaves no temp file behind", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await setSkillOverride("x", "off", p);
    expect((await readdir(dir)).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
  test("survives a corrupt existing file rather than throwing", async () => {
    const dir = await mk(); const p = join(dir, "settings.json");
    await writeFile(p, "{not json");
    await setSkillOverride("x", "off", p);
    expect((await readSettings(p)).skillOverrides).toEqual({ x: "off" });
  });
});

describe("nextOverride", () => {
  test("cycles on -> user-invocable-only -> off -> on", () => {
    expect(nextOverride(undefined)).toBe("user-invocable-only");
    expect(nextOverride("user-invocable-only")).toBe("off");
    expect(nextOverride("off")).toBe("on");
  });
});
