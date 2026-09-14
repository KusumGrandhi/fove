/**
 * Formatting a buffer on save.
 *
 * The rule this service is built around: **use the project's own formatter or
 * none at all.** A formatter is a project decision, encoded in its config and
 * its lockfile, and reformatting somebody's file with a globally-installed
 * prettier of a different major version is a diff nobody asked for -- it
 * lands in their next commit and it is not theirs.
 *
 * So prettier is resolved by walking up from the file for a project-local
 * `node_modules/.bin/prettier`. Not found, nothing happens. `ruff` is treated
 * the same way for Python, with PATH allowed as a fallback only because ruff
 * is a standalone binary people install once per machine rather than per
 * project -- and because it already resolves the project's own config itself,
 * which is the part that actually matters.
 *
 * Text goes in and out over stdin/stdout. Nothing here touches the file: the
 * editor still does the writing, still under its mtime guard, so a formatter
 * cannot become a second writer racing an agent for the same file.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { ensureToolPath } from "./loginPath.js";

const MAX_BUFFER = 16 * 1024 * 1024;
/** A formatter that has not answered by now is in a state nobody's save should wait on. */
const TIMEOUT_MS = 10_000;

/** Extensions prettier handles that anyone would expect it to. */
const PRETTIER_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".json", ".jsonc", ".json5", ".css", ".scss", ".less",
  ".html", ".vue", ".md", ".mdx", ".yaml", ".yml", ".graphql", ".gql",
]);

export interface FormatResult {
  /** The formatted text, or null when nothing was willing to format it. */
  content: string | null;
  /** Which tool did it, for the editor to name in its notice. */
  by?: string;
  /** The formatter ran and failed -- a syntax error, usually. */
  error?: string;
}

/** Run a command with `text` on stdin, resolving to its stdout. */
function pipe(
  bin: string,
  args: string[],
  text: string,
  cwd?: string,
): Promise<{ stdout: string } | { error: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        // A formatter exits non-zero on a syntax error and prints the reason.
        // Returning the half-formatted stdout in that case would corrupt the
        // buffer, so the original text is kept and the reason is reported.
        if (err) resolve({ error: (stderr || err.message).trim().split("\n")[0] ?? "failed" });
        else resolve({ stdout });
      },
    );
    child.stdin?.end(text);
  });
}

export class FormatService {
  /** Resolved binaries, per directory walked from. Formatters do not move mid-session. */
  private readonly prettier = new Map<string, string | null>();
  private ruff: boolean | null = null;

  /**
   * The project's own prettier, found by walking up from the file.
   *
   * Up to the filesystem root rather than to the workspace: a monorepo keeps
   * its tooling at the top and its packages below, and stopping at the pane's
   * cwd would find nothing for exactly those repositories.
   */
  private async findPrettier(from: string): Promise<string | null> {
    const cached = this.prettier.get(from);
    if (cached !== undefined) return cached;

    let dir = from;
    let found: string | null = null;
    for (;;) {
      const candidate = join(dir, "node_modules", ".bin", "prettier");
      try {
        await access(candidate, constants.X_OK);
        found = candidate;
        break;
      } catch {
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    this.prettier.set(from, found);
    return found;
  }

  private async hasRuff(): Promise<boolean> {
    if (this.ruff !== null) return this.ruff;
    this.ruff = await new Promise<boolean>((resolve) => {
      execFile("ruff", ["--version"], { timeout: 5000 }, (err) => resolve(!err));
    });
    return this.ruff;
  }

  /**
   * Format `content` as the file at `path` would be formatted.
   *
   * `content` is passed in rather than read from disk because the buffer being
   * saved is the thing to format -- reading the file would format the version
   * the editor is about to replace.
   */
  async run(path: string, content: string, cwd?: string): Promise<FormatResult> {
    const ext = extname(path).toLowerCase();
    const from = cwd ?? dirname(path);
    // Same reason as the linter: a GUI-launched app cannot see `ruff` until
    // the login shell's PATH is in place.
    await ensureToolPath();

    if (ext === ".py") {
      if (!(await this.hasRuff())) return { content: null };
      const r = await pipe("ruff", ["format", "--stdin-filename", path, "-"], content, from);
      if ("error" in r) return { content: null, by: "ruff", error: r.error };
      return { content: r.stdout, by: "ruff" };
    }

    if (PRETTIER_EXTENSIONS.has(ext)) {
      const bin = await this.findPrettier(from);
      if (!bin) return { content: null };
      const r = await pipe(bin, ["--stdin-filepath", path], content, from);
      if ("error" in r) return { content: null, by: "prettier", error: r.error };
      return { content: r.stdout, by: "prettier" };
    }

    return { content: null };
  }
}
