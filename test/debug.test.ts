/**
 * The debugpy command line.
 *
 * Pure, and tested separately, because argument order here is easy to get
 * wrong and fails in a way that is hard to read: put the program's own flags
 * before the target and debugpy consumes them as its own.
 */

import { describe, expect, it } from "vitest";
import { debugpyArgs } from "../src/main/debug.js";
import type { LaunchConfig } from "../src/shared/launch-config.js";

const base: LaunchConfig = { name: "x", type: "debugpy", request: "launch" };

describe("debugpyArgs", () => {
  it("disables frozen modules, which make debugpy miss breakpoints", () => {
    // debugpy warns about this itself on startup. A silently-skipped
    // breakpoint is worse than a loud failure.
    const args = debugpyArgs(base, 1);
    expect(args[0]).toBe("-Xfrozen_modules=off");
    // It is an interpreter flag, so it must precede -m.
    expect(args.indexOf("-Xfrozen_modules=off")).toBeLessThan(args.indexOf("-m"));
  });

  it("listens on loopback only", () => {
    // Binding all interfaces would expose a debugger port to the network.
    const args = debugpyArgs(base, 5678);
    expect(args.slice(1, 5)).toEqual(["-m", "debugpy", "--listen", "127.0.0.1:5678"]);
  });

  it("waits for the client, so nothing is missed at startup", () => {
    expect(debugpyArgs(base, 1)).toContain("--wait-for-client");
  });

  it("builds core's real Flask invocation", () => {
    const config: LaunchConfig = {
      ...base,
      module: "flask",
      args: ["run", "--no-debugger", "--no-reload"],
    };
    expect(debugpyArgs(config, 5678)).toEqual([
      "-Xfrozen_modules=off",
      "-m", "debugpy", "--listen", "127.0.0.1:5678", "--wait-for-client",
      "-m", "flask",
      "run", "--no-debugger", "--no-reload",
    ]);
  });

  it("puts the program's args after the target, not before", () => {
    // The failure this guards: --no-reload parsed as a debugpy flag.
    const args = debugpyArgs({ ...base, module: "flask", args: ["--no-reload"] }, 1);
    expect(args.indexOf("--no-reload")).toBeGreaterThan(args.indexOf("flask"));
  });

  it("uses a script path when there is no module", () => {
    const args = debugpyArgs({ ...base, program: "/w/run.py" }, 1);
    expect(args).toContain("/w/run.py");
    // `-m debugpy` is always there; what must not appear is a *second* -m,
    // which would make debugpy import the script path as a module name.
    expect(args.filter((a) => a === "-m")).toHaveLength(1);
  });

  it("prefers module over program, as VS Code does", () => {
    const args = debugpyArgs({ ...base, module: "flask", program: "/w/run.py" }, 1);
    expect(args).toContain("flask");
    expect(args).not.toContain("/w/run.py");
  });

  it("works with no args at all", () => {
    expect(debugpyArgs({ ...base, program: "/w/a.py" }, 1)).toEqual([
      "-Xfrozen_modules=off",
      "-m", "debugpy", "--listen", "127.0.0.1:1", "--wait-for-client", "/w/a.py",
    ]);
  });
});
