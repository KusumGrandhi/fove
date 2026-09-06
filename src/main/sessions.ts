/**
 * Background session discovery.
 *
 * Claude Code has a third kind of agent that neither the AGENTS pane nor the
 * teammate bar can see:
 *
 *   - a Task subagent lives *inside* one transcript, linked by
 *     `parent_tool_use_id` -- that is what AgentTree reconstructs;
 *   - a teammate is its own `claude` process in a tmux pane;
 *   - a **background session** is a peer session in the same project folder,
 *     with its own transcript file and its own session id.
 *
 * The third kind is what the CLI's "Working / Needs input / Completed" view
 * lists. Because it is a sibling file rather than a nested record, a service
 * that reads only the newest transcript is structurally blind to it.
 *
 * Reading is deliberately cheap: only the tail of each transcript is parsed,
 * because this polls and the files grow without bound.
 */

import { open, stat } from "node:fs/promises";
import { listSessions, slugForCwd } from "../data/transcript.js";

export type BackgroundState = "working" | "needs-input" | "done" | "idle";

export interface BackgroundSession {
  sessionId: string;
  path: string;
  /** The CLI's own name for the session, when it has titled one. */
  name?: string;
  state: BackgroundState;
  mtimeMs: number;
  /** True for the transcript the pane in this cwd is itself driving. */
  isCurrent: boolean;
}

/** How much of the tail to read. Enough for the recent records, never the whole file. */
const TAIL_BYTES = 64 * 1024;
/** A transcript untouched for longer than this is not actively working. */
const ACTIVE_WINDOW_MS = 90_000;

/** Read the last `TAIL_BYTES` of a file as text, without loading the whole thing. */
async function readTail(path: string, bytes = TAIL_BYTES): Promise<string> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A partial first line is unparseable; drop it.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

/**
 * Derive a session's name and state from its tail.
 *
 * The CLI records a title as `ai-title`/`agent-name`. State is inferred from
 * the last substantive record: a trailing assistant turn that ended means the
 * session is waiting or done, while recent activity means it is working.
 */
function readState(tail: string, mtimeMs: number): { name?: string; state: BackgroundState } {
  let name: string | undefined;
  let sawResult = false;
  let lastRole: string | undefined;

  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // tolerant: unknown or truncated records are skipped, never thrown
    }
    const type = rec.type;
    if (type === "ai-title" && typeof rec.aiTitle === "string") name = rec.aiTitle;
    else if (type === "agent-name" && typeof rec.agentName === "string") name = rec.agentName;
    else if (type === "assistant" || type === "user") lastRole = String(type);
    else if (type === "system" && rec.subtype === "away_summary") sawResult = true;
  }

  const fresh = Date.now() - mtimeMs < ACTIVE_WINDOW_MS;
  let state: BackgroundState;
  if (fresh && lastRole === "user") state = "working";
  else if (fresh && lastRole === "assistant") state = "needs-input";
  else if (sawResult) state = "done";
  else state = fresh ? "working" : "idle";
  return { name, state };
}

/**
 * Every session in a cwd's project folder, newest first.
 *
 * `currentPath` marks the transcript the calling pane already displays, so the
 * UI can list the *others* as background work rather than repeating itself.
 */
export async function backgroundSessions(
  cwd: string,
  currentPath?: string,
): Promise<BackgroundSession[]> {
  const sessions = await listSessions({ slug: slugForCwd(cwd) });
  const out: BackgroundSession[] = [];

  for (const s of sessions) {
    try {
      const st = await stat(s.path);
      if (st.size === 0) continue;
      const { name, state } = readState(await readTail(s.path), st.mtimeMs);
      out.push({
        sessionId: s.sessionId,
        path: s.path,
        name,
        state,
        mtimeMs: st.mtimeMs,
        isCurrent: !!currentPath && s.path === currentPath,
      });
    } catch {
      continue; // a session that vanished mid-scan is not an error
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
