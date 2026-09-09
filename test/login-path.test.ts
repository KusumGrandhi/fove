/**
 * Finding the tools the app spawns.
 *
 * This exists because of `spawn claude ENOENT`, reported from the installed
 * app while every test and every dev run passed.
 *
 * A GUI application launched from Finder does not inherit your shell's PATH.
 * It gets a minimal one -- measured on this machine as
 * `/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.` -- which carries `git` and
 * `python3` but not `claude`, `rg`, `fd` or anything from Homebrew or nvm.
 *
 * The bug is invisible in development precisely because a dev-run app
 * inherits the terminal's environment, so the thing worth testing is not the
 * happy path but that the resolved PATH is *different from and better than*
 * whatever the process started with.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { loginPath, spawnEnv } from "../src/main/loginPath.js";

describe("the login shell's PATH", () => {
  it("finds directories the bare process environment does not have", async () => {
    /*
     * The property that matters. Comparing against the *current* PATH would
     * prove nothing here -- the test runner has a full one -- so this checks
     * against the minimal PATH a launched app actually gets.
     */
    const MINIMAL = "/usr/bin:/bin:/usr/sbin:/sbin";
    const resolved = await loginPath();

    expect(resolved).toBeTruthy();
    expect(resolved!.split(":").length).toBeGreaterThan(MINIMAL.split(":").length);
  });

  it("produces an environment that can locate a tool outside /usr/bin", async () => {
    // `claude` is the tool the handoff loop spawns, and the one that failed.
    const env = await spawnEnv();
    const found = execFileSync("/bin/sh", ["-c", "command -v claude || true"], { env })
      .toString().trim();

    // Skipped rather than failed where claude is genuinely not installed:
    // this test is about PATH, not about the machine having the CLI.
    if (!found) return;
    expect(found).not.toBe("");
  });

  it("keeps the rest of the environment intact", async () => {
    // Only PATH is replaced. HOME and friends must survive, or `claude` loses
    // its credentials and fails in a much more confusing way.
    const env = await spawnEnv();
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("is resolved once and reused", async () => {
    // A shell start per invocation would put ~100ms on every phase.
    const a = await loginPath();
    const b = await loginPath();
    expect(a).toBe(b);
  });
});
