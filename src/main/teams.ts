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
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const TEAMS_DIR = join(homedir(), ".claude", "teams");

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

  /** Recent output from a teammate's pane, for the live view. */
  async capture(socket: string, paneId: string, lines = 200): Promise<string> {
    try {
      return await tmux(socket, ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
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
}
