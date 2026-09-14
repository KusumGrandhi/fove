/**
 * Teammate service: the swarm of real `claude` processes running in tmux.
 *
 * These are distinct from Task subagents. A subagent lives inside one
 * transcript and can only be read after the fact; a teammate is its own
 * process in its own tmux pane, which means it can be watched live,
 * interrupted, and talked to.
 *
 * Two sources, joined:
 *   ~/.claude/teams/<team>/config.json  -- who exists, their prompt and pane id
 *   tmux -L <socket>                     -- what they are doing right now
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureToolPath } from "./loginPath.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);
const TEAMS_DIR = join(homedir(), ".claude", "teams");

/**
 * Every tmux call goes through here, so the login PATH is in place first.
 *
 * `tmux` lives in Homebrew's bin, which a GUI-launched app does not have on
 * its PATH. Without this the spawn fails with ENOENT, every socket reads as
 * stale, and a workspace full of running teammates reports none -- in the
 * installed app only, which is what made it hard to see.
 */
async function run(
  cmd: string,
  args: string[],
  opts: { windowsHide?: boolean; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  await ensureToolPath();
  const { stdout, stderr } = await execFileP(cmd, args, { encoding: "utf8", ...opts });
  return { stdout, stderr };
}

export interface Teammate {
  agentId: string;
  name: string;
  agentType?: string;
  model?: string;
  color?: string;
  prompt?: string;
  cwd?: string;
  tmuxPaneId?: string;
  backendType?: string;
  isActive?: boolean;
  /** Filled from tmux when the pane is still alive. */
  alive?: boolean;
  command?: string;
}

export interface Team {
  name: string;
  socket?: string;
  createdAt?: number;
  leadSessionId?: string;
  members: Teammate[];
}

/**
 * Live tmux sockets named claude-swarm-*.
 *
 * The socket directory is TMUX_TMPDIR, else /tmp/tmux-<uid> -- but macOS maps
 * /tmp to /private/tmp, and a socket file only means the server *was* there.
 * So candidates are probed by actually talking to tmux; a socket that does not
 * answer is a stale file, not a swarm.
 */
async function swarmSockets(): Promise<string[]> {
  const uid = process.getuid?.() ?? 501;
  const dirs = [
    process.env.TMUX_TMPDIR,
    `/private/tmp/tmux-${uid}`,
    `/tmp/tmux-${uid}`,
  ].filter((d): d is string => !!d);

  const names = new Set<string>();
  for (const d of dirs) {
    try {
      for (const e of await readdir(d)) {
        if (e.startsWith("claude-swarm")) names.add(e);
      }
    } catch {
      // Directory may not exist; try the next.
    }
  }

  const live: string[] = [];
  for (const name of names) {
    try {
      await run("tmux", ["-L", name, "list-panes", "-a", "-F", "#{pane_id}"], { windowsHide: true });
      live.push(name);
    } catch {
      // Stale socket file with no server behind it.
    }
  }
  return live;
}

async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await run("tmux", ["-L", socket, ...args], { windowsHide: true });
  return stdout;
}

/** Pane id -> live state, for whichever socket is running. */
async function paneStates(socket: string): Promise<Map<string, { alive: boolean; command: string }>> {
  const out = new Map<string, { alive: boolean; command: string }>();
  try {
    // A literal tab in the format string does not survive tmux, which emits it
    // as "_" -- so fields are separated by a token tmux passes through intact.
    const SEP = "|:|";
    const text = await tmux(socket, [
      "list-panes", "-a", "-F", `#{pane_id}${SEP}#{pane_dead}${SEP}#{pane_current_command}`,
    ]);
    for (const line of text.split("\n")) {
      const [id, dead, command] = line.split(SEP);
      if (id) out.set(id, { alive: dead === "0", command: command ?? "" });
    }
  } catch {
    // Socket gone: every pane reads as not alive.
  }
  return out;
}

export class TeamService {
  /** Every team on disk, newest first, joined with live tmux state. */
  async list(): Promise<Team[]> {
    let names: string[];
    try {
      names = await readdir(TEAMS_DIR);
    } catch {
      return [];
    }

    const sockets = await swarmSockets();
    const states = new Map<string, Map<string, { alive: boolean; command: string }>>();
    for (const s of sockets) states.set(s, await paneStates(s));

    const teams: Team[] = [];
    for (const name of names) {
      const cfgPath = join(TEAMS_DIR, name, "config.json");
      try {
        const st = await stat(cfgPath);
        const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as {
          name?: string; createdAt?: number; leadSessionId?: string; members?: Teammate[];
        };
        // A member is live if any socket still holds its pane.
        let socket: string | undefined;
        const members = (cfg.members ?? []).map((m) => {
          for (const [s, panes] of states) {
            const p = m.tmuxPaneId ? panes.get(m.tmuxPaneId) : undefined;
            if (p) {
              socket ??= s;
              return { ...m, alive: p.alive, command: p.command };
            }
          }
          return { ...m, alive: false };
        });
        teams.push({
          name: cfg.name ?? name,
          socket,
          createdAt: cfg.createdAt ?? st.mtimeMs,
          leadSessionId: cfg.leadSessionId,
          members,
        });
      } catch {
        // Malformed or half-written config: skip rather than fail the list.
      }
    }
    return teams.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /**
   * Recent output from a teammate's pane, for the live view.
   *
   * `-J` joins the lines tmux wrapped to its own pane width. Without it a
   * paragraph comes back hard-broken at whatever column the tmux pane happens
   * to be, which has nothing to do with the width fove is rendering into --
   * so the text looked arbitrarily chopped.
   *
   * No `-e`: the escapes would keep colour, but the view renders into a plain
   * `<pre>`, so they would arrive as literal `[38;5;…m` garbage. Colour is
   * worth having only once something parses it.
   *
   * The `-S -N` window is a request, not a guarantee: tmux clamps it to the
   * pane's `history-limit`, and this server belongs to Claude Code rather than
   * to us, so a pane can hold less than we ask for. That is why a fresh
   * teammate's view can look near-empty and unscrollable -- there genuinely is
   * nothing behind it yet.
   */
  async capture(socket: string, paneId: string, lines = 200): Promise<string> {
    try {
      return await tmux(socket, [
        "capture-pane", "-p", "-J", "-t", paneId, "-S", `-${lines}`,
      ]);
    } catch {
      return "";
    }
  }

  /** Type into a teammate's pane, as if you were sitting at it. */
  async send(socket: string, paneId: string, text: string, enter = true): Promise<boolean> {
    try {
      await tmux(socket, ["send-keys", "-t", paneId, text]);
      if (enter) await tmux(socket, ["send-keys", "-t", paneId, "Enter"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Escape interrupts the current turn, exactly as it does in the terminal. */
  async interrupt(socket: string, paneId: string): Promise<boolean> {
    try {
      await tmux(socket, ["send-keys", "-t", paneId, "Escape"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Give a teammate's pane a window of its own, and say which one.
   *
   * Claude Code puts every teammate in one tiled window, so attaching shows
   * all five at once: `attach -t <pane>` only chooses which pane is *active*,
   * and the client still renders the whole window. Zoom does isolate one
   * visually but is window state shared by every client, so it would reach
   * into Claude Code's own swarm-view -- verified, not assumed.
   *
   * `break-pane` is the mechanism that actually separates them. `-d` leaves
   * focus where it was, so opening a tab does not yank the external view to a
   * different window.
   *
   * Idempotent: a pane already alone in its window is returned as-is rather
   * than broken again, so reopening a tab is free.
   */
  async isolate(
    socket: string,
    paneId: string,
  ): Promise<{ window: string; origin: string | null } | null> {
    try {
      const where = (await tmux(socket, [
        "display-message", "-p", "-t", paneId,
        "#{window_id} #{window_panes}",
      ])).trim();
      const [windowId, panes] = where.split(/\s+/);
      if (!windowId) return null;
      // Already alone: nothing to break, and nothing to put back later.
      if (Number(panes) <= 1) return { window: windowId, origin: null };

      await tmux(socket, ["break-pane", "-d", "-s", paneId]);
      const moved = (await tmux(socket, [
        "display-message", "-p", "-t", paneId, "#{window_id}",
      ])).trim();
      if (!moved) return null;
      return { window: moved, origin: windowId };
    } catch {
      return null;
    }
  }

  /**
   * Put a pane back in the shared window.
   *
   * Called when a teammate tab closes, so the tiled swarm-view Claude Code
   * built is left as it was found. Best-effort: if the original window is
   * gone -- the swarm finished, someone closed it -- the pane simply stays
   * where it is rather than failing the close.
   */
  async rejoin(socket: string, paneId: string, targetWindowId: string): Promise<boolean> {
    try {
      await tmux(socket, ["join-pane", "-d", "-s", paneId, "-t", targetWindowId]);
      return true;
    } catch {
      return false;
    }
  }
}
