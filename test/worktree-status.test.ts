import { describe, expect, it } from "vitest";
import { isInside, sessionsByWorktree } from "../src/shared/worktree-status.js";

describe("isInside", () => {
  it("matches a directory against itself", () => {
    expect(isInside("/a/core", "/a/core")).toBe(true);
  });

  it("matches a subdirectory", () => {
    expect(isInside("/a/core", "/a/core/flask")).toBe(true);
  });

  it("does not match a sibling that shares a prefix", () => {
    // The bug a plain startsWith would have: these are different worktrees.
    expect(isInside("/a/core", "/a/core-old")).toBe(false);
  });

  it("ignores a trailing slash on either side", () => {
    expect(isInside("/a/core/", "/a/core")).toBe(true);
    expect(isInside("/a/core", "/a/core/")).toBe(true);
  });

  it("does not match a parent", () => {
    expect(isInside("/a/core/flask", "/a/core")).toBe(false);
  });
});

describe("sessionsByWorktree", () => {
  const trees = [{ path: "/a/core" }, { path: "/a/core/.warp/worktrees/AGENT" }];

  it("reports zero for a worktree with no session", () => {
    expect(sessionsByWorktree(trees, [])).toEqual(
      new Map([["/a/core", 0], ["/a/core/.warp/worktrees/AGENT", 0]]),
    );
  });

  it("attributes a session in a subdirectory to its worktree", () => {
    const counts = sessionsByWorktree(trees, [{ cwd: "/a/core/flask" }]);
    expect(counts.get("/a/core")).toBe(1);
  });

  it("attributes a nested worktree's session to the deepest match", () => {
    // The session is inside both paths; only the inner one should count it.
    const counts = sessionsByWorktree(trees, [
      { cwd: "/a/core/.warp/worktrees/AGENT/flask" },
    ]);
    expect(counts.get("/a/core/.warp/worktrees/AGENT")).toBe(1);
    expect(counts.get("/a/core")).toBe(0);
  });

  it("counts several sessions in one worktree", () => {
    const counts = sessionsByWorktree(trees, [
      { cwd: "/a/core" },
      { cwd: "/a/core/flask" },
    ]);
    expect(counts.get("/a/core")).toBe(2);
  });

  it("ignores a session outside every worktree", () => {
    const counts = sessionsByWorktree(trees, [{ cwd: "/elsewhere" }]);
    expect([...counts.values()]).toEqual([0, 0]);
  });

  it("ignores a session with no cwd recorded", () => {
    const counts = sessionsByWorktree(trees, [{ cwd: "" }]);
    expect([...counts.values()]).toEqual([0, 0]);
  });
});
