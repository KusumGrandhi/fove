import { describe, expect, test } from "vitest";
import { parseStatus, parseWorktrees, parseDiff, statusLabel } from "../src/shared/git-parse.js";

const Z = "\0";

describe("parseStatus", () => {
  test("reads branch, oid and ahead/behind", () => {
    const out = [
      "# branch.oid 3eb510105a0eb36a0e7db8e559b33df97a8c450d",
      "# branch.head AGENT-913",
      "# branch.upstream origin/AGENT-913",
      "# branch.ab +3 -2",
    ].join(Z) + Z;
    const s = parseStatus(out);
    expect(s.branch).toBe("AGENT-913");
    expect(s.oid).toBe("3eb510105a0eb36a0e7db8e559b33df97a8c450d");
    expect(s.upstream).toBe("origin/AGENT-913");
    expect(s.ahead).toBe(3);
    expect(s.behind).toBe(2);
    expect(s.detached).toBe(false);
  });

  test("detects a detached HEAD", () => {
    expect(parseStatus(`# branch.head (detached)${Z}`).detached).toBe(true);
  });

  test("separates staged from unstaged state", () => {
    const out =
      `1 M. N... 100644 100644 100644 aaa bbb staged-only.ts${Z}` +
      `1 .M N... 100644 100644 100644 aaa bbb unstaged-only.ts${Z}` +
      `1 MM N... 100644 100644 100644 aaa bbb both.ts${Z}`;
    const f = parseStatus(out).files;
    expect(f[0]).toMatchObject({ path: "staged-only.ts", staged: "modified", unstaged: null });
    expect(f[1]).toMatchObject({ path: "unstaged-only.ts", staged: null, unstaged: "modified" });
    expect(f[2]).toMatchObject({ path: "both.ts", staged: "modified", unstaged: "modified" });
  });

  test("handles filenames containing spaces", () => {
    const out = `1 .M N... 100644 100644 100644 aaa bbb src/my file with spaces.ts${Z}`;
    expect(parseStatus(out).files[0]!.path).toBe("src/my file with spaces.ts");
  });

  test("reads a rename, including the original path", () => {
    // Type 2 entries put the OLD path in the following NUL field.
    const out = `2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts${Z}old/name.ts${Z}`;
    const f = parseStatus(out).files[0]!;
    expect(f).toMatchObject({ path: "new/name.ts", from: "old/name.ts", staged: "renamed" });
  });

  test("a rename does not swallow the entry after it", () => {
    const out =
      `2 R. N... 100644 100644 100644 aaa bbb R100 new.ts${Z}old.ts${Z}` +
      `1 .M N... 100644 100644 100644 aaa bbb other.ts${Z}`;
    const f = parseStatus(out).files;
    expect(f).toHaveLength(2);
    expect(f[1]!.path).toBe("other.ts");
  });

  test("reads untracked, ignored and unmerged entries", () => {
    const out = `? new.ts${Z}! build/out.js${Z}u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts${Z}`;
    const f = parseStatus(out).files;
    expect(f[0]).toMatchObject({ path: "new.ts", unstaged: "untracked" });
    expect(f[1]).toMatchObject({ path: "build/out.js", unstaged: "ignored" });
    expect(f[2]).toMatchObject({ path: "conflict.ts", staged: "unmerged" });
  });

  test("lists every file in a new directory, not the directory", () => {
    // What `--untracked-files=all` emits. Git's default would collapse all
    // three into a single `? newdir/` entry, which cannot be staged per file.
    const out = `? newdir/one.py${Z}? newdir/sub/three.py${Z}? newdir/two.py${Z}`;
    const f = parseStatus(out).files;
    expect(f.map((x) => x.path)).toEqual([
      "newdir/one.py",
      "newdir/sub/three.py",
      "newdir/two.py",
    ]);
    expect(f.every((x) => x.unstaged === "untracked")).toBe(true);
  });

  test("a clean repo yields no files", () => {
    expect(parseStatus(`# branch.head main${Z}`).files).toEqual([]);
    expect(parseStatus("").files).toEqual([]);
  });
});

describe("parseWorktrees", () => {
  const sample = [
    "worktree /Users/k/Documents/aiprise/core",
    "HEAD 3eb510105a0eb36a0e7db8e559b33df97a8c450d",
    "branch refs/heads/AGENT-913",
    "",
    "worktree /Users/k/.warp/worktrees/core/AGENT",
    "HEAD 1fe85465893b62203a5d20273620dc66ab802cf6",
    "branch refs/heads/AGENT",
    "",
  ].join("\n");

  test("parses every worktree and strips the refs/heads prefix", () => {
    const w = parseWorktrees(sample);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ path: "/Users/k/Documents/aiprise/core", branch: "AGENT-913" });
    expect(w[1]!.branch).toBe("AGENT");
  });

  test("marks the current worktree", () => {
    const w = parseWorktrees(sample, "/Users/k/.warp/worktrees/core/AGENT");
    expect(w.find((x) => x.current)!.branch).toBe("AGENT");
    expect(w.filter((x) => x.current)).toHaveLength(1);
  });

  test("handles detached, bare, locked and prunable", () => {
    const out = [
      "worktree /a", "HEAD abc", "detached", "",
      "worktree /b", "bare", "",
      "worktree /c", "HEAD def", "branch refs/heads/x", "locked reason here", "prunable gone", "",
    ].join("\n");
    const w = parseWorktrees(out);
    expect(w[0]!.detached).toBe(true);
    expect(w[1]!.bare).toBe(true);
    expect(w[2]).toMatchObject({ locked: true, prunable: true });
  });

  test("tolerates a missing trailing blank line", () => {
    expect(parseWorktrees("worktree /a\nHEAD abc\nbranch refs/heads/m")).toHaveLength(1);
  });

  test("empty input yields nothing", () => {
    expect(parseWorktrees("")).toEqual([]);
  });
});

describe("parseDiff", () => {
  const sample = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 111..222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ function main() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
  ].join("\n");

  test("extracts the file path from the b/ side", () => {
    expect(parseDiff(sample)[0]!.path).toBe("src/app.ts");
  });

  test("counts additions and deletions", () => {
    expect(parseDiff(sample)[0]).toMatchObject({ additions: 2, deletions: 1 });
  });

  test("assigns real line numbers so a click can open the right line", () => {
    const lines = parseDiff(sample)[0]!.hunks[0]!.lines;
    expect(lines[0]).toMatchObject({ kind: "context", oldNo: 10, newNo: 10 });
    expect(lines[1]).toMatchObject({ kind: "del", oldNo: 11 });
    expect(lines[2]).toMatchObject({ kind: "add", newNo: 11 });
    expect(lines[3]).toMatchObject({ kind: "add", newNo: 12 });
    expect(lines[4]).toMatchObject({ kind: "context", oldNo: 12, newNo: 13 });
  });

  test("keeps the hunk header context", () => {
    expect(parseDiff(sample)[0]!.hunks[0]!.header).toBe("function main() {");
  });

  test("splits multiple files", () => {
    const two = sample + "\n" + [
      "diff --git a/README.md b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const files = parseDiff(two);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "README.md"]);
  });

  test("flags binary files instead of trying to render them", () => {
    const out = ["diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ"].join("\n");
    expect(parseDiff(out)[0]).toMatchObject({ path: "img.png", binary: true, hunks: [] });
  });

  test("records a rename's original path", () => {
    const out = ["diff --git a/old.ts b/new.ts", "rename from old.ts", "rename to new.ts"].join("\n");
    expect(parseDiff(out)[0]).toMatchObject({ path: "new.ts", from: "old.ts" });
  });

  test("handles multiple hunks in one file", () => {
    const out = [
      "diff --git a/x.ts b/x.ts",
      "@@ -1,2 +1,2 @@", " a", "-b", "+c",
      "@@ -50,2 +50,2 @@", " d", "-e", "+f",
    ].join("\n");
    const hunks = parseDiff(out)[0]!.hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks[1]!.oldStart).toBe(50);
  });

  test("empty diff yields no files", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("statusLabel", () => {
  test("prefers the staged state", () => {
    expect(statusLabel({ path: "a", staged: "added", unstaged: "modified" })).toBe("A");
    expect(statusLabel({ path: "a", staged: null, unstaged: "untracked" })).toBe("?");
    expect(statusLabel({ path: "a", staged: null, unstaged: "deleted" })).toBe("D");
  });
});
