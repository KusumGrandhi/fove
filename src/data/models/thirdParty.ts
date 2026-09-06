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
 * ~/.claude.json, so a bad entry cannot break the plain CLI. Tokens are read
 * from the environment by name -- never stored here as literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDERS_PATH = join(homedir(), ".config", "cc-wrapper", "providers.json");

export const UNSUPPORTED_NOTICE =
  "Anthropic doesn't endorse, maintain, or audit third-party gateway products, " +
  "and doesn't support routing Claude Code to non-Claude models through any gateway.";

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  /** Name of the env var holding the key -- not the key itself. */
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
];

export async function loadProviders(path = PROVIDERS_PATH): Promise<Provider[]> {
  try {
    const raw = await Bun.file(path).json();
    if (Array.isArray(raw)) {
      const extra = raw.filter((p): p is Provider => !!p && typeof p.id === "string");
      const ids = new Set(extra.map((p) => p.id));
      return [...BUILTIN_PROVIDERS.filter((p) => !ids.has(p.id)), ...extra];
    }
  } catch {
    // No user file: builtins only.
  }
  return BUILTIN_PROVIDERS;
}

/** Resolve the key from the environment. Returns undefined when unset. */
export function tokenFor(p: Provider): string | undefined {
  return p.authTokenEnv ? process.env[p.authTokenEnv] : undefined;
}

/** Whether this provider can actually be used right now. */
export function isUsable(p: Provider): boolean {
  return !p.thirdParty || tokenFor(p) !== undefined;
}
