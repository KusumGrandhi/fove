/**
 * Running a Claude Code agent, and reading what it wrote.
 *
 * The v0.9 runner composed the prompt for every phase in TypeScript. Three
 * string constants, compiled into the app, invisible to the person using it --
 * and the executor's read, in full, was *"Carry out this plan exactly"* plus a
 * list of steps. No ticket, no codebase context, no way to run a test. Then a
 * reviewer with the real diff found six genuine problems and it looked as
 * though the model was bad.
 *
 * Claude Code already has the right shape for this. An agent is a markdown
 * file: frontmatter naming its tools, then its prompt. So fove does not write
 * prompts any more. It spawns `claude --agent <name>`, waits, and reads the
 * file the agent was told to write.
 *
 * Everything below was measured against the installed CLI rather than read
 * from `--help`, and two findings changed the design:
 *
 *   - **`--json-schema` returns `structured_output: null` when `--agent` is
 *     used.** The mechanism the whole v0.9 loop rested on does not survive the
 *     move, which is why the agent writes a file instead. That is a better
 *     shape anyway: writing the file is a deliberate act the agent takes, not
 *     a shape imposed on whatever it happened to say last.
 *   - **`--permission-mode plan` blocks `Write` even when the agent declares
 *     it.** So a planner that must write its plan cannot run in plan mode, and
 *     the safety property has to come from somewhere else.
 *
 * That somewhere else is **the agent file plus the tree itself**, and the route
 * there was not the one intended. `--allowed-tools "Write(<one path>)"` looked
 * like the answer and does not work: measured against the installed CLI, a
 * `Write(...)` entry is denied even when the requested path is byte-identical
 * to the granted one. Only bare `Write` grants the tool.
 *
 * So the planner is restrained by what its agent file tells it -- *"the only
 * file you may write is the plan file you are given"* -- and fove checks the
 * result rather than trusting it: the snapshot taken before planning says
 * whether anything else moved. An instruction plus a check beats a permission
 * that silently is not one, which is what the previous design had.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnEnv } from "./loginPath.js";

/**
 * How long one agent may run before it is killed.
 *
 * The budget caps *usage*, which is a different thing: an agent that hangs
 * without producing tokens costs nothing and would otherwise wait forever.
 * Twenty minutes is deliberately generous -- planning a real ticket means
 * reading the codebase, and a ceiling that fires during honest work is worse
 * than none. This is the "something is wrong" bound.
 */
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Where a run's artifacts live: inside the workspace, under `.claude/`.
 *
 * Not `~/.fove/runs/`, which is where this started. Measured against the
 * installed CLI: `--allowed-tools "Write(<path>)"` grants a path only when it
 * is **inside the working directory** -- an absolute path outside `cwd` is
 * denied whatever the allowlist says. So an agent cannot write to a directory
 * in your home, and the artifacts have to live in the repository.
 *
 * Not `.claude/` either, which was the obvious choice since the agent files
 * live there and `core` already ignores it. **Claude Code refuses writes into
 * `.claude/`** -- it protects its own configuration directory, and the refusal
 * looks exactly like a permission problem: one denial, no file, whatever the
 * allowlist says. That cost an hour of chasing symlinks and tool syntax.
 *
 * So `.fove/` at the repository root: writable, one directory, and fove adds
 * it to `.git/info/exclude` so it stays out of `git status` without touching a
 * `.gitignore` that belongs to the repository and its other contributors.
 */
export const runsRoot = (cwd: string): string => join(cwd, ".fove", "runs");

export interface AgentRun {
  /** Agent name, matching the `name:` in `.claude/agents/<name>.md`. */
  agent: string;
  /** The prompt. The *task*, not instructions -- those live in the agent file. */
  prompt: string;
  cwd: string;
  /** Absolute path the agent is told to write, and the only one it may write. */
  outputPath?: string;
  /**
   * Tools this invocation may use, as `--allowed-tools` entries.
   *
   * Tool *names* only, and `Bash(cmd:*)` patterns, which do work. A
   * `Write(<path>)` entry does not grant anything -- verified against the
   * installed CLI -- so path scoping is not available here and must not be
   * written as though it were.
   */
  allowedTools?: string[];
  permissionMode?: "plan" | "acceptEdits" | "default";
  budgetUSD?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with stdout as it arrives, for showing work in progress. */
  onOutput?: (chunk: string) => void;
}

export interface AgentResult<T = unknown> {
  ok: boolean;
  /** Parsed contents of `outputPath`, when the agent wrote it. */
  output?: T;
  /** The agent's final message. Useful when it talked instead of writing. */
  text: string;
  costUSD: number;
  sessionId?: string;
  denials: number;
  error?: string;
}

/**
 * Keep fove's artifacts out of `git status`, without editing `.gitignore`.
 *
 * `.git/info/exclude` is the per-clone ignore file: it is not committed, so a
 * shared repository never sees it. Writing to `.gitignore` would put fove into
 * a diff belonging to the repository and everyone working in it, which is the
 * same rule that keeps your intents in your home directory.
 */
async function excludeFromGit(cwd: string): Promise<void> {
  const file = join(cwd, ".git", "info", "exclude");
  try {
    const body = await readFile(file, "utf8").catch(() => "");
    if (body.split("\n").some((l) => l.trim() === ".fove/")) return;
    await mkdir(join(cwd, ".git", "info"), { recursive: true });
    const sep = body === "" || body.endsWith("\n") ? "" : "\n";
    await writeFile(file, `${body}${sep}.fove/\n`, "utf8");
  } catch {
    // Not a git repository, or no permission. The artifacts still work; they
    // only show as untracked, which is untidy rather than broken.
  }
}

/**
 * A directory for one handoff's artifacts, so runs cannot collide.
 *
 * The path is resolved through symlinks before use. `--allowed-tools
 * "Write(<path>)"` compares paths literally, and on macOS a temp directory is
 * reached as `/var/...` while `cwd` resolves to `/private/var/...` -- the same
 * directory by two names, which the permission check reads as two places and
 * denies. Costly to find and invisible once fixed.
 */
export async function makeRunDir(cwd: string): Promise<string> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const real = await realpath(cwd).catch(() => cwd);
  const dir = join(runsRoot(real), id);
  await mkdir(dir, { recursive: true });
  await excludeFromGit(real);
  return dir;
}

/** Remove a run's artifacts. Best effort: a leftover directory harms nothing. */
export async function forgetRun(cwd: string, dir: string): Promise<void> {
  if (!dir.startsWith(runsRoot(cwd))) return; // never delete outside our own tree
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Run one agent to completion.
 *
 * Never throws. Every failure here is something to show in the pane -- a
 * missing agent file, a timeout, an agent that talked instead of writing --
 * and a loop that crashes on one is worse than one that reports it, because
 * the working tree may already have changes in it.
 */
export async function runAgent<T = unknown>(run: AgentRun): Promise<AgentResult<T>> {
  const env = await spawnEnv();

  /*
   * Resolve `cwd` through symlinks before spawning.
   *
   * `--allowed-tools "Write(<path>)"` compares paths literally, and the agent
   * resolves its own working directory. On macOS a temp repo is reached as
   * `/var/...` but resolves to `/private/var/...`: the same directory under
   * two names, which the permission check reads as two places and denies. The
   * grant and the process must agree on the spelling.
   */
  const cwd = await realpath(run.cwd).catch(() => run.cwd);

  const argv = [
    "-p", run.prompt,
    "--agent", run.agent,
    "--output-format", "json",
    ...(run.permissionMode ? ["--permission-mode", run.permissionMode] : []),
    ...(run.allowedTools?.length ? ["--allowed-tools", run.allowedTools.join(",")] : []),
    ...(run.budgetUSD && run.budgetUSD > 0 ? ["--max-budget-usd", String(run.budgetUSD)] : []),
  ];

  const raw = await new Promise<{
    out: string; err: string; timedOut: boolean; spawnError?: string;
  }>((resolve) => {
    const child = spawn("claude", argv, {
      cwd,
      env,
      windowsHide: true,
      // Its own process group, so a kill reaches the whole tree. `claude`
      // spawns children; signalling only the parent leaves them holding the
      // stdio pipes open and `close` never fires -- which turns a timeout into
      // the same hang it was meant to end.
      detached: true,
    });

    const killTree = (signal: NodeJS.Signals = "SIGTERM"): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    let out = "";
    let err = "";
    let size = 0;
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      // A runaway agent must not take the app's memory with it.
      if (size > 32 * 1024 * 1024) { killTree(); return; }
      const text = c.toString();
      out += text;
      run.onOutput?.(text);
    });
    child.stderr.on("data", (c: Buffer) => { err += c.toString().slice(0, 4000); });

    run.signal?.addEventListener("abort", () => killTree(), { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // SIGTERM is a request; if the tree is still there shortly after, stop
      // asking. Otherwise the timeout has only moved the hang later.
      setTimeout(() => killTree("SIGKILL"), 2000).unref?.();
    }, run.timeoutMs ?? AGENT_TIMEOUT_MS);

    const finish = (spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, err, timedOut, spawnError });
    };

    child.on("error", (e) => finish(e.message));
    child.on("close", () => finish());
  });

  if (raw.spawnError) {
    return { ok: false, text: "", costUSD: 0, denials: 0, error: raw.spawnError };
  }
  if (raw.timedOut) {
    const mins = Math.round((run.timeoutMs ?? AGENT_TIMEOUT_MS) / 60000);
    return {
      ok: false, text: "", costUSD: 0, denials: 0,
      error: `${run.agent} produced no result after ${mins} minutes — stopped`,
    };
  }

  let parsed: {
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    session_id?: string;
    permission_denials?: unknown[];
  };
  try {
    parsed = JSON.parse(raw.out) as typeof parsed;
  } catch {
    // Not JSON: the CLI failed before producing a result. A missing agent file
    // lands here, and whatever is on stderr is the part worth showing.
    return {
      ok: false, text: raw.out.slice(0, 2000), costUSD: 0, denials: 0,
      error: raw.err.trim() || `${run.agent} produced no parseable result`,
    };
  }

  const base = {
    text: parsed.result ?? "",
    costUSD: parsed.total_cost_usd ?? 0,
    sessionId: parsed.session_id,
    denials: (parsed.permission_denials ?? []).length,
  };

  if (parsed.is_error) {
    return { ...base, ok: false, error: base.text || `${run.agent} reported an error` };
  }
  if (!run.outputPath) return { ...base, ok: true };

  /*
   * The file is the result.
   *
   * An agent that talked instead of writing is a failure, and it is reported
   * as one rather than as an empty plan. "It produced nothing" and "it decided
   * there was nothing to do" must never look the same -- the same rule the
   * drift reviewer follows.
   */
  try {
    const body = await readFile(run.outputPath, "utf8");
    return { ...base, ok: true, output: JSON.parse(body) as T };
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `${run.agent} did not write ${run.outputPath}`
      : `${run.agent} wrote ${run.outputPath}, but it is not valid JSON`;
    return { ...base, ok: false, error: why };
  }
}
