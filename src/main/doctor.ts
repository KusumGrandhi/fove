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
import { DEPS, type Dep, type DepStatus } from "../shared/deps.js";
import { spawnEnv } from "./loginPath.js";

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
async function locate(dep: Dep, env: NodeJS.ProcessEnv): Promise<DepStatus> {
  const shell = process.env.SHELL || "/bin/zsh";
  let path: string | undefined;
  try {
    const { stdout } = await run(shell, ["-l", "-c", `command -v ${dep.bin}`], {
      env, windowsHide: true, timeout: 5000,
    });
    path = stdout.trim().split("\n")[0] || undefined;
  } catch {
    return { bin: dep.bin };
  }
  if (!path) return { bin: dep.bin };

  let version: string | undefined;
  if (dep.versionArg) {
    try {
      const { stdout } = await run(path, [dep.versionArg], {
        env, windowsHide: true, timeout: 5000,
      });
      version = stdout.trim().split("\n")[0] || undefined;
    } catch {
      // Present but uncommunicative. Still present.
    }
  }
  return { bin: dep.bin, path, version };
}

/** Look for every dependency, concurrently. */
export async function check(): Promise<DepStatus[]> {
  const env = await spawnEnv();
  return Promise.all(DEPS.map((d) => locate(d, env)));
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

  const env = await spawnEnv();
  try {
    await run("brew", ["--version"], { env, windowsHide: true, timeout: 10_000 });
  } catch {
    return {
      ok: false,
      output: "Homebrew is not installed. See https://brew.sh, then try again.",
    };
  }

  try {
    const { stdout, stderr } = await run("brew", ["install", dep.brew], {
      env, windowsHide: true,
      // A formula that builds from source can take minutes.
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: (err.stderr || err.stdout || err.message || "brew failed").trim(),
    };
  }
}
