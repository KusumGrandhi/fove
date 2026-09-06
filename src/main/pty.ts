/**
 * PTY service. One pseudo-terminal per terminal pane.
 *
 * Scrollback is retained here, in the main process, rather than in the
 * renderer: a pane that is moved, re-parented or re-mounted must not lose its
 * history, and React will unmount/remount its xterm instance freely.
 */

import * as pty from "node-pty";
import type { IPty } from "node-pty";

const SCROLLBACK_LIMIT = 512 * 1024;

/**
 * Minimum usable terminal size.
 *
 * A pane that has not been laid out yet reports 0x0, and a 2x2 pty is worse
 * than useless -- a full-screen TUI like Claude Code draws its first frame and
 * then wedges, because there is nowhere to put its UI. Starting at a sane size
 * and letting the first real resize correct it avoids that entirely.
 */
const MIN_COLS = 20;
const MIN_ROWS = 5;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface Session {
  paneId: string;
  proc: IPty;
  /** Everything written so far, capped, for replay on remount. */
  buffer: string;
  cols: number;
  rows: number;
  exited: boolean;
}

/**
 * The environment a pane's process should see.
 *
 * Anything Claude Code sets for *its own* child processes must not leak into a
 * `claude` this app spawns: with CLAUDE_CODE_CHILD_SESSION or an inherited
 * ENTRYPOINT present, the new process believes it is already inside another
 * session, refuses to attach to this app as an IDE, and disables transcript
 * saving. This matters whenever fove is launched from a terminal that is
 * itself running Claude Code.
 *
 * CLAUDE_CONFIG_DIR is preserved -- it is a legitimate user setting, and tests
 * rely on it pointing at a fixture.
 */
function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key === "CLAUDE_CONFIG_DIR") continue;
    if (key.startsWith("CLAUDE_") || key.startsWith("CLAUDECODE")) delete env[key];
  }
  // Set by Electron itself; with it present a spawned Electron runs as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, TERM: "xterm-256color", ...extra };
}

export class PtyService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly onData: (paneId: string, data: string) => void,
    private readonly onExit: (paneId: string, code: number) => void,
  ) {}

  /** Default to the user's login shell so their profile and prompt apply. */
  static defaultShell(): string {
    return process.env.SHELL || "/bin/zsh";
  }

  spawn(req: {
    paneId: string;
    cmd?: string;
    args?: string[];
    cwd?: string;
    cols: number;
    rows: number;
    /** Extra environment, e.g. the IDE vars that let `claude` find this app. */
    env?: Record<string, string>;
  }): Session {
    const existing = this.sessions.get(req.paneId);
    if (existing && !existing.exited) return existing;

    const shell = PtyService.defaultShell();
    let cmd: string;
    let args: string[];
    if (req.cmd) {
      // Run the command *through* the login shell rather than exec'ing it
      // directly. A bare spawn only sees the PATH this process inherited, which
      // on macOS omits everything ~/.zshrc adds -- `claude` lives in
      // /opt/homebrew/bin or ~/.local/bin and would simply not be found, so the
      // pane died with "[process exited 1]" while typing the same word into a
      // shell pane worked.
      //
      // -l -i -c so both the login profile and the interactive rc file run:
      // PATH edits commonly live in either. `exec` replaces the shell, so the
      // pane's process really is the command and signals reach it directly.
      const quoted = [req.cmd, ...(req.args ?? [])]
        .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
        .join(" ");
      cmd = shell;
      args = ["-l", "-i", "-c", `exec ${quoted}`];
    } else {
      cmd = shell;
      // A login shell so ~/.zshrc, PATH and the user's prompt are present.
      args = req.args ?? ["-l"];
    }

    const proc = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols: req.cols >= MIN_COLS ? req.cols : DEFAULT_COLS,
      rows: req.rows >= MIN_ROWS ? req.rows : DEFAULT_ROWS,
      cwd: req.cwd || process.env.HOME,
      env: cleanEnv(req.env),
    });

    const session: Session = {
      paneId: req.paneId,
      proc,
      buffer: "",
      cols: req.cols,
      rows: req.rows,
      exited: false,
    };
    this.sessions.set(req.paneId, session);

    proc.onData((d) => {
      session.buffer += d;
      if (session.buffer.length > SCROLLBACK_LIMIT) {
        session.buffer = session.buffer.slice(-SCROLLBACK_LIMIT);
      }
      this.onData(req.paneId, d);
    });
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      this.onExit(req.paneId, exitCode);
    });

    return session;
  }

  write(paneId: string, data: string): void {
    const s = this.sessions.get(paneId);
    if (s && !s.exited) s.proc.write(data);
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId);
    if (!s || s.exited) return;
    // Ignore degenerate sizes from a pane mid-drag or not yet laid out.
    const c = Math.floor(cols);
    const r = Math.floor(rows);
    if (c < MIN_COLS || r < MIN_ROWS) return;
    if (c === s.cols && r === s.rows) return;
    s.cols = c;
    s.rows = r;
    try {
      s.proc.resize(c, r);
    } catch {
      // The process can exit between the check and the call.
    }
  }

  /** Replayed into a freshly mounted xterm so history survives a remount. */
  scrollback(paneId: string): string {
    return this.sessions.get(paneId)?.buffer ?? "";
  }

  has(paneId: string): boolean {
    const s = this.sessions.get(paneId);
    return !!s && !s.exited;
  }

  kill(paneId: string): void {
    const s = this.sessions.get(paneId);
    if (!s) return;
    try {
      if (!s.exited) s.proc.kill();
    } catch {
      // Already gone.
    }
    this.sessions.delete(paneId);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
