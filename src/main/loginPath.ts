/**
 * The PATH a login shell would have.
 *
 * A GUI application launched from Finder does **not** inherit your shell's
 * PATH. It gets a minimal one -- measured on this machine:
 * `/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.` -- which has `git` and
 * `python3` but not `claude`, `rg`, `fd`, `node` or anything installed by
 * Homebrew or nvm.
 *
 * That is invisible in development, because a dev-run app inherits the
 * terminal's environment and everything resolves. It only appears once the
 * app is opened the way people actually open it, and then it appears as
 * `spawn claude ENOENT`.
 *
 * The terminal panes never hit this: they spawn through `zsh -l -i`, which
 * sources the profile. This does the same once and caches the answer, so the
 * rest of the app can spawn tools by name the way the panes already can.
 */

import { spawn } from "node:child_process";

let cached: Promise<string | undefined> | null = null;

/**
 * Resolve the login shell's PATH, once per process.
 *
 * Returns `undefined` when the shell cannot be read or takes too long, and
 * callers fall back to the inherited PATH -- no worse than not asking.
 */
export function loginPath(): Promise<string | undefined> {
  cached ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    // `-l -i` because PATH is commonly set in .zshrc (interactive) rather
    // than .zprofile (login), and missing either one is the whole bug.
    const child = spawn(shell, ["-l", "-i", "-c", 'printf %s "$PATH"'], {
      windowsHide: true,
    });

    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.on("error", () => resolve(undefined));

    // A profile that hangs -- waiting on a prompt, a slow network mount --
    // must not hang the app with it.
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 5000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim() || undefined);
    });
  });
  return cached;
}

/**
 * The environment to spawn a user-facing tool with.
 *
 * The login PATH is *appended*, never substituted. Whatever the process
 * already has comes first, so a PATH someone set deliberately -- a test
 * pointing at a fake binary, a user launching from a terminal with a tool
 * shadowed on purpose -- still wins. This only adds places to look.
 */
export async function spawnEnv(): Promise<NodeJS.ProcessEnv> {
  const extra = await loginPath();
  const current = process.env.PATH ?? "";
  if (!extra) return { ...process.env };

  const seen = new Set(current.split(":").filter(Boolean));
  const added = extra.split(":").filter((d) => d && !seen.has(d));
  const PATH = added.length > 0 ? [current, ...added].filter(Boolean).join(":") : current;

  return { ...process.env, PATH };
}
