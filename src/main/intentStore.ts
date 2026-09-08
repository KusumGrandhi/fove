/**
 * Where intents live: `~/.fove/intents/<repo-identity>/`.
 *
 * **Never inside the working tree.** This is a hard constraint, not a
 * preference. `core` is a production repository shared with a team; a `.fove/`
 * directory in it would mean opening a PR to put one developer's tooling
 * config into everyone's checkout. That is not ours to do, and a tool that
 * requires it does not get used.
 *
 * The costs, accepted rather than hidden:
 *
 *   - intents are yours, not the team's. They do not arrive by `git pull`.
 *   - a mechanism cannot be a pre-commit hook or a CI check, because it does
 *     not live in the repo. It runs when fove asks, for you.
 *   - nothing fove writes ever appears in `git status`. A tool that dirties a
 *     production working tree is one you have to remember to clean up before
 *     every commit.
 *
 * Keyed by repository *identity* rather than path, so a worktree shares its
 * parent's intents instead of starting empty -- verified across `core` and its
 * worktrees, which report the same remote and the same root commit.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fromMarkdown, toMarkdown, seedCandidates, type Intent } from "../shared/intents.js";

const run = promisify(execFile);

/** Root of everything fove stores about other people's repositories. */
export const FOVE_HOME = join(homedir(), ".fove");

/**
 * A stable id for a repository.
 *
 * The first remote URL, else the root commit sha. Both survive a clone and are
 * shared by every worktree; a filesystem path is neither. Hashed so the
 * directory name is safe and bounded, with a readable prefix so the folder is
 * still identifiable by eye.
 */
export async function repoIdentity(cwd: string): Promise<string | null> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run("git", args, { cwd, windowsHide: true });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };

  const remote = await git(["remote", "get-url", "origin"]);
  /*
   * With no remote, the *common git directory* rather than the root commit.
   *
   * The root sha looked right and is not: two repositories created from
   * identical content at the same second produce the same root commit, so
   * unrelated projects would share an intent store and mix each other's rules.
   * Reproduced directly before changing this, not theorised.
   *
   * `--git-common-dir` is unique per repository and identical across all of its
   * worktrees -- both properties this needs. It is a path, so it does not
   * survive a clone; a clone with no remote at all is rare enough to accept
   * starting empty.
   */
  const common = remote
    ? null
    : await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const raw = remote ?? common;
  if (!raw) return null;

  /*
   * The readable half comes from the *identity*, never from the directory.
   *
   * An earlier version used the checkout's folder name, which is different for
   * every worktree -- so `core` and `core/.claude/worktrees/foo` got separate
   * stores and an intent written in one was invisible from the other. Caught by
   * the worktree test, which is why it exists.
   */
  const first = raw.split("\n")[0]!;
  const label = remote
    ? (first.replace(/\.git$/, "").split(/[/:]/).pop() ?? "repo")
    : "repo";
  const hash = createHash("sha256").update(first).digest("hex").slice(0, 10);
  return `${label}-${hash}`;
}

export interface StoredIntents {
  /** Null when the directory is not a git repository. */
  identity: string | null;
  dir: string | null;
  intents: Intent[];
  /** Rules found in the repo's own conventions file, not yet adopted. */
  candidates: { name: string; text: string; from: string }[];
}

export class IntentStore {
  /** Everything known about a workspace's intents. */
  async load(cwd: string): Promise<StoredIntents> {
    const identity = await repoIdentity(cwd);
    if (!identity) {
      return { identity: null, dir: null, intents: [], candidates: [] };
    }

    const dir = join(FOVE_HOME, "intents", identity);
    const intents: Intent[] = [];

    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".md")) continue;
        try {
          const text = await readFile(join(dir, name), "utf8");
          intents.push(fromMarkdown(name.replace(/\.md$/, ""), text));
        } catch {
          // One unreadable file costs that file, not the whole set.
        }
      }
    } catch {
      // No directory yet: a workspace with no intents, which is the norm.
    }

    return { identity, dir, intents, candidates: await this.candidates(cwd, intents) };
  }

  /**
   * Rules the repository already documents but fove has not adopted.
   *
   * Read-only, always: fove reads `AGENTS.md` and `CLAUDE.md` and never writes
   * to either. Anything already adopted is filtered out so the list is work
   * remaining rather than a re-listing of what is done.
   */
  private async candidates(
    cwd: string,
    existing: Intent[],
  ): Promise<{ name: string; text: string; from: string }[]> {
    const adopted = new Set(
      existing.flatMap((i) => i.clauses.map((c) => c.text.toLowerCase().trim())),
    );

    const out: { name: string; text: string; from: string }[] = [];
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const md = await readFile(join(cwd, file), "utf8");
        for (const c of seedCandidates(md)) {
          if (adopted.has(c.text.toLowerCase().trim())) continue;
          out.push({ ...c, from: file });
        }
      } catch {
        // Absent is the common case and not an error.
      }
    }
    return out;
  }

  /** Write an intent. Creates the store on first use. */
  async save(cwd: string, intent: Intent): Promise<{ ok: boolean; path?: string }> {
    const identity = await repoIdentity(cwd);
    if (!identity) return { ok: false };

    const dir = join(FOVE_HOME, "intents", identity);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${safeId(intent.id)}.md`);
    await writeFile(path, toMarkdown(intent), "utf8");
    return { ok: true, path };
  }

  async remove(cwd: string, id: string): Promise<{ ok: boolean }> {
    const identity = await repoIdentity(cwd);
    if (!identity) return { ok: false };
    try {
      await rm(join(FOVE_HOME, "intents", identity, `${safeId(id)}.md`));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Run a clause's mechanism.
   *
   * A shell command from the workspace root; exit zero is a pass. Deliberately
   * plain -- a mechanism is usually a `rg` invocation or a single test, and
   * anything needing more than a command line is a judgment, which belongs to
   * an agent rather than here.
   *
   * The result is *not* cached across sessions. A clause proven yesterday is
   * not proven now, and `proven` only means something if it means now.
   */
  async runMechanism(
    cwd: string,
    command: string,
  ): Promise<{ passed: boolean; output: string; ranAt: number }> {
    try {
      const { stdout, stderr } = await run("/bin/sh", ["-c", command], {
        cwd,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return { passed: true, output: (stdout || stderr).slice(0, 4000), ranAt: Date.now() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return {
        passed: false,
        output: (err.stdout || err.stderr || err.message || "failed").slice(0, 4000),
        ranAt: Date.now(),
      };
    }
  }
}

/** A filename-safe id. Intent ids come from user input. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "intent";
}
