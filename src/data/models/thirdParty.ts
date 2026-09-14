/**
 * Third-party providers behind an Anthropic-compatible Messages API.
 *
 * OFFICIALLY UNSUPPORTED. Anthropic's documentation states verbatim:
 *
 *   "Anthropic doesn't endorse, maintain, or audit third-party gateway
 *    products, and doesn't support routing Claude Code to non-Claude models
 *    through any gateway."
 *
 * It works in practice, but expect: prompt caching not to apply (cost and
 * latency get WORSE, not better), extended thinking to be absent, and tool-call
 * formatting to diverge -- which shows up as the agentic loop stalling or
 * looping. Token accounting becomes unreliable, so cost display is suppressed.
 *
 * Config lives in this app's own file, never in ~/.claude/settings.json or
 * ~/.claude.json, so a bad entry cannot break the plain CLI. This file holds env
 * var NAMES, never key literals: a key is read from the environment, or from the
 * keychain-encrypted store in main/providerKeys.ts when the environment lacks it.
 */

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Provider config lives in fove's own directory, never in ~/.claude.json or
 * ~/.claude/settings.json, so a bad entry here cannot break the plain CLI.
 */
export const PROVIDERS_PATH = join(homedir(), ".config", "fove", "providers.json");

/** Where earlier builds kept it; read once so existing setups keep working. */
export const LEGACY_PROVIDERS_PATH = join(homedir(), ".config", "cc-wrapper", "providers.json");

export const UNSUPPORTED_NOTICE =
  "Anthropic doesn't endorse, maintain, or audit third-party gateway products, " +
  "and doesn't support routing Claude Code to non-Claude models through any gateway.";

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  /** Name of the env var holding the key, and the slot it is saved under -- not the key itself. */
  authTokenEnv: string;
  models: string[];
  thirdParty: boolean;
  notes?: string;
}

/** Verified endpoints. Shipped as defaults; the user's file overrides them. */
export const BUILTIN_PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    authTokenEnv: "",
    models: [],
    thirdParty: false,
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authTokenEnv: "MOONSHOT_API_KEY",
    models: ["kimi-k2.5"],
    thirdParty: true,
    notes: "No prompt caching; thinking absent; tool-call format may diverge.",
  },
  {
    id: "zhipu",
    label: "Zhipu / GLM",
    baseUrl: "https://api.z.ai/api/anthropic",
    authTokenEnv: "ZAI_API_KEY",
    models: ["glm-5.1"],
    thirdParty: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authTokenEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-reasoner"],
    thirdParty: true,
  },
  {
    // OpenRouter fronts many vendors behind one key, which is what makes it
    // worth having: one entry reaches dozens of models. Its Anthropic-shaped
    // endpoint is what Claude Code can speak.
    id: "openrouter",
    label: "OpenRouter",
    // No /v1: Claude Code appends /v1/messages, and /api/v1 makes that
    // /api/v1/v1/messages, whose 404 it reports as "model may not exist".
    baseUrl: "https://openrouter.ai/api",
    authTokenEnv: "OPENROUTER_API_KEY",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1",
      "moonshotai/kimi-k2",
      "qwen/qwen3-235b-a22b",
    ],
    thirdParty: true,
    notes:
      "Routes to many vendors behind one key. Prompt caching usually does not " +
      "apply, so cost and latency can get worse; tool-call formatting varies by " +
      "model, which shows up as the agentic loop stalling or looping.",
  },
];

export async function loadProviders(path = PROVIDERS_PATH): Promise<Provider[]> {
  // The legacy location is read only when the current one is absent, so an
  // existing setup keeps working without being silently migrated.
  for (const candidate of [path, LEGACY_PROVIDERS_PATH]) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8"));
      if (Array.isArray(raw)) {
        const extra = raw.filter((p): p is Provider => !!p && typeof p.id === "string");
        const ids = new Set(extra.map((p) => p.id));
        return [...BUILTIN_PROVIDERS.filter((p) => !ids.has(p.id)), ...extra];
      }
    } catch {
      // Missing or malformed: try the next candidate, then fall back.
    }
  }
  return BUILTIN_PROVIDERS;
}

/** Looks up a key the app has saved, given the env var name it belongs to. */
export type StoredKeys = (name: string) => string | undefined;

/**
 * Resolve the key by env var name, falling back to whatever the app has saved.
 *
 * The environment is checked first so an explicit export stays an override. The
 * fallback exists because a Dock-launched GUI app never sees the user's shell
 * environment; see main/providerKeys.ts for where saved keys actually live.
 */
export function tokenFor(p: Provider, stored?: StoredKeys): string | undefined {
  if (!p.authTokenEnv) return undefined;
  return process.env[p.authTokenEnv] ?? stored?.(p.authTokenEnv);
}

/** Where a resolved key came from, so the UI can offer to clear only its own. */
export function tokenSource(p: Provider, stored?: StoredKeys): "env" | "stored" | null {
  if (!p.authTokenEnv) return null;
  if (process.env[p.authTokenEnv]) return "env";
  return stored?.(p.authTokenEnv) ? "stored" : null;
}

/** Whether this provider can actually be used right now. */
export function isUsable(p: Provider, stored?: StoredKeys): boolean {
  return !p.thirdParty || tokenFor(p, stored) !== undefined;
}
