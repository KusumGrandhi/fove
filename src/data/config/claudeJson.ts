/**
 * READ-ONLY access to ~/.claude.json.
 *
 * That file holds live credentials in plaintext alongside ~600 keys of
 * server-pushed cache and per-project history. This app never writes it:
 * round-tripping through JSON.parse/stringify risks dropping keys it does not
 * model and clobbering concurrent CLI writes. Config writes go to
 * ~/.claude/settings.json (see settingsFile.ts).
 *
 * Secrets are redacted at this boundary so they never enter app state, logs or
 * crash reports.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_JSON = join(homedir(), ".claude.json");

/** Values that look like credentials, redacted on read. */
const SECRET = /^(ghp_|github_pat_|sk-|Bearer\s|Basic\s|xox[baprs]-)/i;
const SECRET_KEY = /(authorization|api[-_]?key|token|secret|password|cookie)/i;

export const REDACTED = "••••";

export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return SECRET.test(value) || (SECRET_KEY.test(key) && value.length > 8) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export interface SkillUsage {
  usageCount: number;
  lastUsedAt?: number;
}

export interface ClaudeJsonView {
  skillUsage: Map<string, SkillUsage>;
  mcpServers: { name: string; scope: "global" | "project"; project?: string; type?: string }[];
  projects: string[];
  numStartups?: number;
}

/** Read the parts we care about, redacted. Returns empty view on any failure. */
export async function readClaudeJson(path = CLAUDE_JSON): Promise<ClaudeJsonView> {
  const view: ClaudeJsonView = { skillUsage: new Map(), mcpServers: [], projects: [] };
  let raw: Record<string, unknown>;
  try {
    raw = await Bun.file(path).json();
  } catch {
    return view;
  }

  const su = raw.skillUsage;
  if (su && typeof su === "object") {
    for (const [name, v] of Object.entries(su as Record<string, unknown>)) {
      if (typeof v === "number") view.skillUsage.set(name, { usageCount: v });
      else if (v && typeof v === "object") {
        const o = v as { usageCount?: number; lastUsedAt?: number };
        view.skillUsage.set(name, {
          usageCount: o.usageCount ?? 0,
          lastUsedAt: o.lastUsedAt,
        });
      }
    }
  }

  const global = raw.mcpServers;
  if (global && typeof global === "object") {
    for (const [name, cfg] of Object.entries(global as Record<string, unknown>)) {
      view.mcpServers.push({
        name,
        scope: "global",
        type: (cfg as { type?: string })?.type,
      });
    }
  }

  const projects = raw.projects;
  if (projects && typeof projects === "object") {
    for (const [path, cfg] of Object.entries(projects as Record<string, unknown>)) {
      view.projects.push(path);
      const m = (cfg as { mcpServers?: Record<string, unknown> })?.mcpServers;
      if (m && typeof m === "object") {
        for (const [name, sc] of Object.entries(m)) {
          view.mcpServers.push({
            name,
            scope: "project",
            project: path,
            type: (sc as { type?: string })?.type,
          });
        }
      }
    }
  }

  if (typeof raw.numStartups === "number") view.numStartups = raw.numStartups;
  return view;
}
