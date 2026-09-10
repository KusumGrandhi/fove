import { describe, expect, test } from "vitest";
import { launchCwd } from "../src/shared/launch-cwd.js";

const HOME = "/Users/someone";

describe("launchCwd", () => {
  test("a real working directory wins over everything", () => {
    // Someone who ran `fove` inside a project meant that project.
    expect(launchCwd({
      cwd: "/work/project",
      recent: ["/work/other"],
      home: HOME,
    })).toBe("/work/project");
  });

  test("Finder's `/` falls through to the last workspace", () => {
    // The bug this exists for: a Spotlight launch inherits "/".
    expect(launchCwd({
      cwd: "/",
      recent: ["/work/last", "/work/older"],
      home: HOME,
    })).toBe("/work/last");
  });

  test("with no history it falls through to home", () => {
    expect(launchCwd({ cwd: "/", home: HOME })).toBe(HOME);
    expect(launchCwd({ cwd: "/", recent: [], home: HOME })).toBe(HOME);
  });

  test("skips unusable entries in the history", () => {
    expect(launchCwd({
      cwd: "/",
      recent: [undefined, "", "/", "/work/real"],
      home: HOME,
    })).toBe("/work/real");
  });

  test("treats an empty or missing cwd like Finder's", () => {
    expect(launchCwd({ cwd: "", recent: ["/work/x"], home: HOME })).toBe("/work/x");
    expect(launchCwd({ recent: ["/work/x"], home: HOME })).toBe("/work/x");
    expect(launchCwd({ cwd: ".", recent: ["/work/x"], home: HOME })).toBe("/work/x");
  });

  test("trims what it returns", () => {
    expect(launchCwd({ cwd: "  /work/p  ", home: HOME })).toBe("/work/p");
    expect(launchCwd({ cwd: "/", recent: [" /work/r "], home: HOME })).toBe("/work/r");
  });

  test("a directory named like a root is not treated as one", () => {
    // "/opt" merely starts with "/"; only "/" itself is useless.
    expect(launchCwd({ cwd: "/opt", home: HOME })).toBe("/opt");
  });
});
