/**
 * Looking for the tools fove needs, and installing the ones brew can.
 *
 * The check has to run with the *login* shell's PATH, not the app's. A
 * Finder-launched Electron app inherits a minimal PATH that contains almost
 * nothing a developer installs, so `claude` and `rg` would read as missing on
 * a machine where both work perfectly in a terminal -- a doctor that lies is
 * worse than no doctor.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEPS, type DepStatus } from "../shared/deps.js";
import { spawnEnv } from "./loginPath.js";
import { interpreterFor } from "./interpreters.js";
import { chosenInterpreter } from "./pythonEnv.js";

const run = promisify(execFile);

/**
 * Locate one dependency, and ask its version.
 *
 * `command -v` through the login shell rather than `which`: it is the
 * portable spelling, and going through the shell means a tool provided by a
 * shell function or an alias-shaped shim still resolves.
 *
 * A version is nice-to-have -- a tool that is present but refuses `--version`
 * is still present, so a failure here narrows the report rather than voiding
 * it.
 */
async function locate(
  bin: string,
  versionArg: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DepStatus> {
  const shell = process.env.SHELL || "/bin/zsh";
  let path: string | undefined;
  try {
    const { stdout } = await run(shell, ["-l", "-c", `command -v ${bin}`], {
      env, windowsHide: true, timeout: 5000,
    });
    path = stdout.trim().split("\n")[0] || undefined;
  } catch {
    return { bin };
  }
  if (!path) return { bin };

  let version: string | undefined;
  if (versionArg) {
    try {
      const { stdout } = await run(path, [versionArg], {
        env, windowsHide: true, timeout: 5000,
      });
      version = stdout.trim().split("\n")[0] || undefined;
    } catch {
      // Present but uncommunicative. Still present.
    }
  }
  return { bin, path, version };
}

/**
 * Look for every dependency, concurrently.
 *
 * Alternatives are looked for too, because a dep they satisfy is not missing.
 * They are asked for no version: a dep met by an alternative already reports
 * that alternative's path, which is the part worth seeing, and the version
 * flags of four Python language servers are not all the same.
 */
export async function check(): Promise<DepStatus[]> {
  const env = await spawnEnv();
  const probes = DEPS.flatMap((d) => [
    { bin: d.bin, versionArg: d.versionArg },
    ...(d.alternatives ?? []).map((bin) => ({ bin, versionArg: undefined })),
  ]);
  return Promise.all(probes.map((p) => locate(p.bin, p.versionArg, env)));
}

/** What Python one project resolves to, for the setup sheet to report. */
export interface PythonEnv {
  root: string;
  /** Absolute interpreter path, or null when nothing was found. */
  path: string | null;
  version?: string;
  /** True when the user picked this rather than fove guessing. */
  chosen: boolean;
}

/**
 * The interpreter each open project would use.
 *
 * This belongs in the setup sheet because it is exactly the kind of failure
 * the sheet exists to prevent: a machine where every tool is installed, the
 * language server starts, and go-to-definition still silently does nothing for
 * every third-party import because nothing knows which environment the project
 * uses. "Pyright ✓" was true and useless on its own.
 *
 * It cannot be auto-fixed -- no file in a repository need say which Python it
 * wants, and picking wrong sends you into the wrong copy of a library. So the
 * sheet names the interpreter it would use and lets the reader notice it is
 * the wrong one, which is the part that was missing.
 */
export async function pythonEnvs(roots: string[]): Promise<PythonEnv[]> {
  const env = await spawnEnv();
  const unique = [...new Set(roots.filter(Boolean))];
  return Promise.all(unique.map(async (root): Promise<PythonEnv> => {
    const path = await interpreterFor(root);
    const chosen = chosenInterpreter(root) !== null;
    if (!path) return { root, path: null, chosen };
    let version: string | undefined;
    try {
      const { stdout } = await run(path, ["-c", "import sys;print(sys.version.split()[0])"], {
        env, windowsHide: true, timeout: 8000,
      });
      version = stdout.trim() || undefined;
    } catch {
      // An interpreter that will not start is still the one that would be
      // used; saying so is more useful than omitting the row.
    }
    return { root, path, version, chosen };
  }));
}

export interface InstallResult {
  ok: boolean;
  /** brew's own output, which is the useful thing on failure. */
  output: string;
}

/**
 * Install one dependency with Homebrew.
 *
 * Only formulas named in the spec are installable, and the formula comes from
 * `DEPS` rather than from the caller -- so this cannot be talked into running
 * `brew install` on arbitrary text arriving over IPC.
 *
 * brew itself is never installed: it wants its own interactive, sudo-prompting
 * script, and running that unattended on someone's machine is not a thing an
 * editor should do. Its absence is reported instead.
 */
export async function install(bin: string): Promise<InstallResult> {
  const dep = DEPS.find((d) => d.bin === bin);
  if (!dep?.brew) {
    return { ok: false, output: `${bin} is not installable with Homebrew.` };
  }

  const base = await spawnEnv();
  try {
    await run("brew", ["--version"], { env: base, windowsHide: true, timeout: 30_000 });
  } catch {
    return {
      ok: false,
      output: "Homebrew is not installed. See https://brew.sh, then try again.",
    };
  }

  /*
   * brew, told that nobody is watching.
   *
   * Every one of these is the difference between an install that finishes and
   * one that looks like the button did nothing:
   *
   * - NO_AUTO_UPDATE: `brew install` otherwise refreshes every tap first,
   *   which is a multi-minute git fetch before the thing you asked for even
   *   starts -- and it is the step most likely to fail on a machine whose brew
   *   has not been touched in a while.
   * - NO_INSTALL_CLEANUP: cleaning up other formulae is not what was clicked.
   * - NO_ENV_HINTS / NO_COLOR: hints and escape codes are noise in a dialog.
   * - NO_INSTALL_FROM_API is NOT set: the API path is the fast one.
   *
   * Nothing here can answer a prompt -- there is no terminal on the other end
   * of this -- so a formula that asks a question hangs until the timeout. That
   * case is reported as itself below rather than as a generic failure.
   */
  const env = {
    ...base,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_COLOR: "1",
  };

  try {
    const { stdout, stderr } = await run("brew", ["install", dep.brew], {
      env, windowsHide: true,
      // A formula that builds from source can take minutes.
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as {
      stdout?: string; stderr?: string; message?: string; killed?: boolean;
    };
    if (err.killed) {
      return {
        ok: false,
        output:
          `brew install ${dep.brew} was still running after ten minutes and was stopped.\n` +
          `Run it in a terminal to see what it is waiting on.`,
      };
    }
    /*
     * brew's *whole* output, not its tail.
     *
     * The last few lines of a failed brew run are usually "Error: ..." with
     * the reason several lines above it -- a broken dependency, a formula that
     * needs relinking. Truncating to the tail threw away the only part worth
     * reading, which made every failure look the same.
     */
    const said = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, output: said || err.message?.trim() || "brew failed" };
  }
}
