/**
 * Tolerant reader for Claude Code transcript .jsonl files.
 *
 * The format is undocumented and changes between CLI releases, so every
 * function here is written to degrade rather than fail: unparseable lines are
 * counted and skipped, unknown record types are ignored, and missing fields
 * are treated as absent rather than exceptional. A transcript that is half
 * new-format is still half useful.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { SessionSummary, TranscriptRecord } from "./types.js";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

export interface ParseStats {
  total: number;
  parsed: number;
  skipped: number;
}

/** Parse one line. Returns null for blank or malformed lines (never throws). */
export function parseLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as TranscriptRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Stream a transcript file record by record.
 *
 * Uses Bun's streaming reader so a 11MB transcript does not land in memory as
 * one string. Handles the final line without a trailing newline.
 */
export async function* readTranscript(
  path: string,
  stats?: ParseStats,
): AsyncGenerator<TranscriptRecord> {
  // Streamed, not read whole: a single transcript reaches 11MB on this machine.
  const stream = createReadStream(path);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      if (stats) stats.total++;
      const rec = parseLine(line);
      if (rec) {
        if (stats) stats.parsed++;
        yield rec;
      } else if (stats) stats.skipped++;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    if (stats) stats.total++;
    const rec = parseLine(buffer);
    if (rec) {
      if (stats) stats.parsed++;
      yield rec;
    } else if (stats) stats.skipped++;
  }
}

/** Convert an absolute cwd to its project-directory slug. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * List every session transcript on disk, newest first.
 *
 * Main-session transcripts are `<projects>/<slug>/<uuid>.jsonl`. Subagent logs
 * live in `<slug>/<uuid>/subagents/` and are deliberately excluded here -- they
 * are attached to their parent session by the tree builder, not listed as
 * sessions in their own right.
 */
export async function listSessions(opts: { slug?: string } = {}): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  let slugs: string[];
  try {
    slugs = opts.slug ? [opts.slug] : await readdir(PROJECTS_DIR);
  } catch {
    return out;
  }

  for (const slug of slugs) {
    const dir = join(PROJECTS_DIR, slug);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const st = await stat(path);
        if (!st.isFile()) continue;
        out.push({
          sessionId: entry.slice(0, -".jsonl".length),
          projectSlug: slug,
          path,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // Vanished between readdir and stat; ignore.
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Paths of the subagent logs belonging to a session, if any. */
export async function listSubagentLogs(session: SessionSummary): Promise<string[]> {
  const dir = join(PROJECTS_DIR, session.projectSlug, session.sessionId, "subagents");
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(dir, e));
  } catch {
    return [];
  }
}

/**
 * The `agent-<agentId>.meta.json` sidecar beside each subagent log.
 *
 * This is the join key between the two id spaces: subagent logs are keyed by
 * `agentId` (a hex string), while the main transcript keys the spawning call by
 * its `toolu_...` tool_use id. Without this, the same agent appears as two
 * unrelated nodes.
 */
export interface SubagentMeta {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

/** Load every subagent meta sidecar for a session, keyed by agentId. */
export async function loadSubagentMeta(
  session: SessionSummary,
): Promise<Map<string, SubagentMeta>> {
  const dir = join(PROJECTS_DIR, session.projectSlug, session.sessionId, "subagents");
  const out = new Map<string, SubagentMeta>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const agentId = entry.slice("agent-".length, -".meta.json".length);
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), "utf8"));
      if (raw && typeof raw === "object") out.set(agentId, { agentId, ...raw });
    } catch {
      // Missing or malformed sidecar: the agent still renders, just unnamed.
    }
  }
  return out;
}
