/**
 * Tools the user installed must be findable from a GUI-launched app.
 *
 * This guards a bug class, not a bug. A macOS app opened from Finder or
 * Spotlight gets a minimal PATH -- `/usr/bin:/bin:/usr/sbin:/sbin` -- with
 * none of Homebrew, conda, nvm or `~/.local/bin` in it. Every service that
 * spawns a tool by bare name therefore works perfectly in `npm start`, which
 * inherits the terminal's environment, and does nothing at all once the app
 * is installed.
 *
 * It fails *silently*, too, which is what makes it worth a test: the teammate
 * bar showed no agents rather than an error, and the linter reported every
 * Python file as clean. Measured in the packaged app before the fix --
 * `teamsList` returned every team with `socket: undefined` and every member
 * `alive: false`, including one that was visibly running.
 *
 * So: any main-process file that spawns one of these by name must first put
 * the login shell's PATH in place, either by awaiting `ensureToolPath()` or by
 * passing `spawnEnv()` as the child's environment.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAIN = "src/main";

/**
 * Tools that live outside a GUI app's PATH.
 *
 * `git` is left out on purpose: macOS ships `/usr/bin/git`, so it resolves
 * even in the minimal environment.
 */
const USER_INSTALLED = ["tmux", "ruff", "claude", "rg", "code", "prettier", "pyright-langserver"];

function mainSources(): { name: string; text: string }[] {
  return readdirSync(MAIN)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ name: n, text: readFileSync(join(MAIN, n), "utf8") }));
}

/** Comments blanked, so prose naming a tool does not count as spawning it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("tools spawned by name", () => {
  test("every file that spawns a user-installed tool prepares the PATH first", () => {
    const offenders: string[] = [];

    for (const { name, text } of mainSources()) {
      if (name === "loginPath.ts") continue;
      const body = code(text);

      const spawns = USER_INSTALLED.filter((tool) =>
        new RegExp(`(execFile|execFileP|spawn|run)\\w*\\(\\s*["'\`]${tool}["'\`]`).test(body),
      );
      if (spawns.length === 0) continue;

      const prepared = /ensureToolPath\s*\(/.test(body) || /spawnEnv\s*\(/.test(body);
      if (!prepared) offenders.push(`${name} spawns ${spawns.join(", ")}`);
    }

    expect(offenders, "these will silently do nothing in the installed app").toEqual([]);
  });

  test("the services that broke in the packaged app are covered", () => {
    // Named explicitly so that deleting the guard from one of them fails here
    // rather than passing because the regex above stopped matching.
    for (const file of ["teams.ts", "lint.ts", "format.ts", "lsp.ts", "openExternal.ts"]) {
      const body = code(readFileSync(join(MAIN, file), "utf8"));
      expect(/ensureToolPath\s*\(/.test(body) || /spawnEnv\s*\(/.test(body), `${file}`).toBe(true);
    }
  });

  test("the login PATH is added to the process environment, never substituted", () => {
    // A replaced PATH would break a deliberately-set one -- a test pointing at
    // a fake binary, or someone launching from a terminal with a tool shadowed.
    const body = code(readFileSync(join(MAIN, "loginPath.ts"), "utf8"));
    expect(body).toMatch(/process\.env\.PATH\s*=\s*\[current/);
    expect(body).toMatch(/seen\.has\(d\)/);
  });
});
