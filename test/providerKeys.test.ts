import { expect, test, describe, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKey, setKey, clearKey, storedLookup, setCrypto, KEYS_PATH, type Crypto,
} from "../src/main/providerKeys.js";
import { BUILTIN_PROVIDERS, tokenFor, tokenSource, isUsable } from "../src/data/models/thirdParty.js";

/** A keychain stand-in: reversible, and obviously not the plaintext. */
const fake = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`cipher:${plain}`, "utf8"),
  decryptString: (buf) => {
    const s = buf.toString("utf8");
    if (!s.startsWith("cipher:")) throw new Error("not ours");
    return s.slice("cipher:".length);
  },
});

const tmps: string[] = [];
async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fove-keys-"));
  tmps.push(dir);
  return join(dir, "keys.json");
}

beforeEach(() => setCrypto(fake()));
afterEach(async () => {
  setCrypto(null);
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("provider key store", () => {
  test("a saved key survives a fresh read", async () => {
    const path = await store();
    expect(getKey("OPENROUTER_API_KEY", path)).toBeUndefined();
    setKey("OPENROUTER_API_KEY", "sk-or-live", path);
    setCrypto(fake()); // drops the in-memory cache, forcing a real reload
    expect(getKey("OPENROUTER_API_KEY", path)).toBe("sk-or-live");
  });

  test("the key is never written as plaintext", async () => {
    const path = await store();
    setKey("OPENROUTER_API_KEY", "sk-or-secret", path);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("sk-or-secret");
    expect(JSON.parse(raw)).toHaveProperty("OPENROUTER_API_KEY");
  });

  test("the file is not readable by other local users", async () => {
    const path = await store();
    setKey("OPENROUTER_API_KEY", "sk-or-live", path);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  test("refuses to store when the platform cannot encrypt", async () => {
    const path = await store();
    setCrypto(fake(false));
    expect(() => setKey("OPENROUTER_API_KEY", "sk-or-live", path)).toThrow(/keychain/i);
  });

  test("keys are independent and forgetting one leaves the others", async () => {
    const path = await store();
    setKey("OPENROUTER_API_KEY", "sk-or", path);
    setKey("DEEPSEEK_API_KEY", "sk-ds", path);
    clearKey("OPENROUTER_API_KEY", path);
    setCrypto(fake());
    expect(getKey("OPENROUTER_API_KEY", path)).toBeUndefined();
    expect(getKey("DEEPSEEK_API_KEY", path)).toBe("sk-ds");
  });

  test("an entry encrypted under another keychain is dropped, not fatal", async () => {
    const path = await store();
    setKey("DEEPSEEK_API_KEY", "sk-ds", path);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.OPENROUTER_API_KEY = Buffer.from("garbage-from-another-mac").toString("base64");
    await writeFile(path, JSON.stringify(stored));
    setCrypto(fake());
    expect(getKey("OPENROUTER_API_KEY", path)).toBeUndefined();
    expect(getKey("DEEPSEEK_API_KEY", path)).toBe("sk-ds");
  });

  test("a missing store is empty rather than an error", async () => {
    expect(getKey("OPENROUTER_API_KEY", "/nonexistent/keys.json")).toBeUndefined();
  });

  test("lives under fove, never in ~/.claude", () => {
    expect(KEYS_PATH).toContain("/.config/fove/");
    expect(KEYS_PATH).not.toContain(".claude");
  });
});

describe("key resolution order", () => {
  const or = BUILTIN_PROVIDERS.find((p) => p.id === "openrouter")!;
  const had = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (had === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = had;
  });

  test("a saved key makes a provider usable with nothing in the environment", async () => {
    const path = await store();
    delete process.env.OPENROUTER_API_KEY;
    expect(isUsable(or, storedLookup(path))).toBe(false);
    setKey("OPENROUTER_API_KEY", "sk-or-saved", path);
    expect(isUsable(or, storedLookup(path))).toBe(true);
    expect(tokenFor(or, storedLookup(path))).toBe("sk-or-saved");
    expect(tokenSource(or, storedLookup(path))).toBe("stored");
  });

  test("an exported key overrides the saved one", async () => {
    const path = await store();
    setKey("OPENROUTER_API_KEY", "sk-or-saved", path);
    process.env.OPENROUTER_API_KEY = "sk-or-exported";
    expect(tokenFor(or, storedLookup(path))).toBe("sk-or-exported");
    expect(tokenSource(or, storedLookup(path))).toBe("env");
  });

  test("no key anywhere reports no source", async () => {
    const path = await store();
    delete process.env.OPENROUTER_API_KEY;
    expect(tokenFor(or, storedLookup(path))).toBeUndefined();
    expect(tokenSource(or, storedLookup(path))).toBeNull();
  });
});
