/**
 * Link a pane to the Claude session actually running inside it.
 *
 * The rail used to pick the newest transcript in the pane's directory, which
 * is only right when exactly one session exists. Open this project in VS Code
 * and a fove pane at once and the newest file is whichever was typed in last —
 * so the token counts belonged to a session the user was not looking at, and
 * appeared to change on their own.
 *
 * Claude Code writes `~/.claude/sessions/<pid>.json` containing `pid`,
 * `sessionId` and `cwd`. Walking up from the pane's shell to a pid in that set
 * gives the exact session, with no guessing.
 *
 * These files are **undocumented**, so everything here is best-effort: any
 * failure falls back to the newest-transcript heuristic rather than leaving
 * the rail blank. Nothing else depends on it.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
}

/**
 * Every session Claude Code currently advertises.
 *
 * A record whose process is gone is dropped: these files outlive the sessions
 * that wrote them, and a stale entry would point the rail at a dead session.
 */
export async function liveSessions(): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const out: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await readFile(join(SESSIONS_DIR, name), "utf8")) as Partial<LiveSession>;
      if (typeof rec.pid !== "number" || typeof rec.sessionId !== "string") continue;
      try {
        // Signal 0 tests for existence without touching the process.
        process.kill(rec.pid, 0);
      } catch {
        continue; // the session has exited
      }
      out.push({ pid: rec.pid, sessionId: rec.sessionId, cwd: String(rec.cwd ?? "") });
    } catch {
      continue; // unreadable or malformed: skip this one only
    }
  }
  return out;
}

/**
 * Every descendant pid of `root`, including itself.
 *
 * A pane runs a login shell that execs `claude`, and `claude` may spawn more
 * processes, so the session pid can be several levels down. One `ps` call
 * builds the whole tree; polling each pid individually would be far slower.
 */
export async function descendants(root: number): Promise<Set<number>> {
  const found = new Set<number>([root]);
  let rows: string[];
  try {
    const { stdout } = await run("ps", ["-eo", "pid=,ppid="], { windowsHide: true });
    rows = stdout.split("\n");
  } catch {
    return found;
  }

  const children = new Map<number, number[]>();
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }

  // Breadth-first, so a deep tree cannot blow the stack.
  const queue = [root];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of children.get(next) ?? []) {
      if (found.has(child)) continue; // cycles cannot happen, but cost nothing to guard
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * The session id running under `shellPid`, or null when none is.
 *
 * Returning null is meaningful: it says "this pane is not running Claude",
 * which the rail should show plainly rather than filling in with another
 * session's numbers.
 */
export async function sessionForPid(shellPid: number): Promise<string | null> {
  const [sessions, tree] = await Promise.all([liveSessions(), descendants(shellPid)]);
  const match = sessions.find((s) => tree.has(s.pid));
  return match?.sessionId ?? null;
}
