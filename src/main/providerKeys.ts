/**
 * Persistent storage for third-party provider keys.
 *
 * The env-var-only rule was sound for secrecy and wrong for usability: a GUI app
 * launched from the Dock inherits launchd's environment, not the user's shell,
 * so `export OPENROUTER_API_KEY=...` in ~/.zshrc never reaches this process and
 * the picker keeps saying "set OPENROUTER_API_KEY" no matter what the user does.
 *
 * Keys are encrypted with Electron's safeStorage -- the OS keychain on macOS --
 * and only the ciphertext is written to disk. That preserves the invariant the
 * provider config documents (no key literals at rest) while letting the app
 * remember a key across launches. When the platform cannot encrypt, writing
 * fails loudly rather than degrading to a plaintext file on disk.
 *
 * The environment still wins over the store, so an explicit export remains an
 * override and existing setups keep behaving exactly as they did.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Ciphertext lives beside providers.json, never inside it. */
export const KEYS_PATH = join(homedir(), ".config", "fove", "keys.json");

/** Env var name -> base64 of safeStorage ciphertext. */
type KeyFile = Record<string, string>;

/** Decrypted keys per file, loaded once each. Keyed by path so two stores never alias. */
const cache = new Map<string, Map<string, string>>();

/** Injectable so tests need neither Electron nor a keychain. */
export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

let crypto: Crypto | null = null;

/** Electron is imported lazily: this module is loaded by tests that have no app. */
function vault(): Crypto {
  if (!crypto) crypto = require("electron").safeStorage as Crypto;
  return crypto;
}

/** Tests substitute a fake keychain; passing null restores the real one. */
export function setCrypto(c: Crypto | null): void {
  crypto = c;
  cache.clear();
}

function readFile(path: string): KeyFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as KeyFile) : {};
  } catch {
    return {};
  }
}

function load(path: string): Map<string, string> {
  const hit = cache.get(path);
  if (hit) return hit;
  const out = new Map<string, string>();
  const stored = readFile(path);
  const box = vault();
  if (box.isEncryptionAvailable()) {
    for (const [name, b64] of Object.entries(stored)) {
      // One unreadable entry must not sink the rest: a key encrypted under a
      // different keychain (restored machine, new user) is simply dropped.
      try {
        out.set(name, box.decryptString(Buffer.from(b64, "base64")));
      } catch {
        continue;
      }
    }
  }
  cache.set(path, out);
  return out;
}

/** The stored key for an env var name, or undefined when none is saved. */
export function getKey(name: string, path = KEYS_PATH): string | undefined {
  return name ? load(path).get(name) : undefined;
}

/** Bound lookup for `tokenFor`/`isUsable`, which take a resolver rather than importing this. */
export function storedLookup(path = KEYS_PATH): (name: string) => string | undefined {
  return (name) => getKey(name, path);
}

/** Save a key. Throws when the platform cannot encrypt, rather than writing plaintext. */
export function setKey(name: string, value: string, path = KEYS_PATH): void {
  const box = vault();
  if (!box.isEncryptionAvailable()) {
    throw new Error("No OS keychain available, so the key cannot be stored encrypted.");
  }
  const stored = readFile(path);
  stored[name] = box.encryptString(value).toString("base64");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The file is ciphertext, but 0600 keeps it out of reach of other local users anyway.
  writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  load(path).set(name, value);
}

/** Forget a key. Removing the last one removes the file rather than leaving `{}` behind. */
export function clearKey(name: string, path = KEYS_PATH): void {
  const stored = readFile(path);
  delete stored[name];
  if (Object.keys(stored).length === 0) rmSync(path, { force: true });
  else writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  load(path).delete(name);
}
