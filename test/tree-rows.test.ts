import { describe, expect, test } from "vitest";
import { flattenTree, ancestorsWithin } from "../src/shared/tree-rows.js";
import type { TreeEntry } from "../src/shared/tree-rows.js";

const R = "/repo";

/** Terse entry builders -- size is irrelevant to flattening. */
const d = (path: string): TreeEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1), path, dir: true, size: 0,
});
const f = (path: string): TreeEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1), path, dir: false, size: 1,
});

describe("flattenTree", () => {
  test("a collapsed root shows only its own children", () => {
    const children = new Map([[R, [d(`${R}/src`), f(`${R}/README.md`)]]]);
    const rows = flattenTree(R, children, new Set());
    expect(rows.map((r) => [r.name, r.depth, r.open])).toEqual([
      ["src", 0, false],
      ["README.md", 0, false],
    ]);
  });

  test("an open directory splices its children in beneath it", () => {
    const children = new Map([
      [R, [d(`${R}/src`), f(`${R}/README.md`)]],
      [`${R}/src`, [f(`${R}/src/main.ts`)]],
    ]);
    const rows = flattenTree(R, children, new Set([`${R}/src`]));
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["src", 0],
      ["main.ts", 1],
      ["README.md", 0],
    ]);
    expect(rows[0]!.open).toBe(true);
  });

  test("nests to arbitrary depth", () => {
    const children = new Map([
      [R, [d(`${R}/a`)]],
      [`${R}/a`, [d(`${R}/a/b`)]],
      [`${R}/a/b`, [d(`${R}/a/b/c`)]],
      [`${R}/a/b/c`, [f(`${R}/a/b/c/deep.py`)]],
    ]);
    const open = new Set([`${R}/a`, `${R}/a/b`, `${R}/a/b/c`]);
    expect(flattenTree(R, children, open).map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  test("an open directory with no listing yet contributes no children", () => {
    // The fetch is still in flight: the row is open, nothing hangs off it.
    const children = new Map([[R, [d(`${R}/src`)]]]);
    const rows = flattenTree(R, children, new Set([`${R}/src`]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.open).toBe(true);
  });

  test("a cached but collapsed directory stays collapsed", () => {
    const children = new Map([
      [R, [d(`${R}/src`)]],
      [`${R}/src`, [f(`${R}/src/main.ts`)]],
    ]);
    expect(flattenTree(R, children, new Set())).toHaveLength(1);
  });

  test("open state on a file is ignored", () => {
    const children = new Map([[R, [f(`${R}/a.ts`)]]]);
    expect(flattenTree(R, children, new Set([`${R}/a.ts`]))[0]!.open).toBe(false);
  });

  test("an unloaded root yields no rows", () => {
    expect(flattenTree(R, new Map(), new Set())).toEqual([]);
  });
});

describe("ancestorsWithin", () => {
  test("lists each directory down to the file, outermost first", () => {
    expect(ancestorsWithin(R, `${R}/flask/core/agents/schemas.py`)).toEqual([
      `${R}/flask`,
      `${R}/flask/core`,
      `${R}/flask/core/agents`,
    ]);
  });

  test("a file directly in the root needs nothing opened", () => {
    expect(ancestorsWithin(R, `${R}/README.md`)).toEqual([]);
  });

  test("excludes the target itself, even when it is a directory", () => {
    expect(ancestorsWithin(R, `${R}/a/b`)).toEqual([`${R}/a`]);
  });

  test("a path outside the root yields nothing", () => {
    expect(ancestorsWithin(R, "/elsewhere/a.ts")).toEqual([]);
    // A sibling whose name merely starts with the root's must not match.
    expect(ancestorsWithin(R, "/repo-other/a.ts")).toEqual([]);
  });

  test("the root itself yields nothing", () => {
    expect(ancestorsWithin(R, R)).toEqual([]);
  });

  test("a trailing slash on the root is tolerated", () => {
    expect(ancestorsWithin("/repo/", "/repo/a/b.ts")).toEqual(["/repo/a"]);
  });
});
