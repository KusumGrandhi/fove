/**
 * File tree operations, against a temp directory.
 *
 * `trash` is not exercised here: it calls into Electron's shell, which is not
 * available under vitest, and a test that really trashed files would leave
 * litter in the user's bin. Its contract is that it never unlinks.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTreeService } from "../src/main/files.js";

let dir: string;
const fs = new FileTreeService();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-tree-"));
  await writeFile(join(dir, "a.txt"), "hello\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFile", () => {
  test("creates an empty file", async () => {
    const r = await fs.createFile(join(dir, "new.ts"));
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, "new.ts"), "utf8")).toBe("");
  });

  test("refuses to clobber an existing file", async () => {
    const r = await fs.createFile(join(dir, "a.txt"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exists");
    // The original content must survive the refusal.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello\n");
  });

  test("creates missing parent directories", async () => {
    const r = await fs.createFile(join(dir, "deep", "nested", "x.ts"));
    expect(r.ok).toBe(true);
    expect((await stat(join(dir, "deep", "nested"))).isDirectory()).toBe(true);
  });

  test("an unwritable directory is an error, not a throw", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const r = await fs.createFile(join(locked, "nope.txt"));
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    await chmod(locked, 0o700); // so afterEach can clean up
  });
});

describe("createDir", () => {
  test("creates a folder", async () => {
    expect((await fs.createDir(join(dir, "sub"))).ok).toBe(true);
    expect((await stat(join(dir, "sub"))).isDirectory()).toBe(true);
  });

  test("refuses an existing path", async () => {
    expect((await fs.createDir(join(dir, "a.txt"))).ok).toBe(false);
  });
});

describe("rename", () => {
  test("moves a file and reports the new path", async () => {
    const to = join(dir, "b.txt");
    const r = await fs.rename(join(dir, "a.txt"), to);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(to);
    expect(await readFile(to, "utf8")).toBe("hello\n");
  });

  test("refuses to overwrite an existing file", async () => {
    await writeFile(join(dir, "b.txt"), "keep me\n");
    const r = await fs.rename(join(dir, "a.txt"), join(dir, "b.txt"));
    expect(r.ok).toBe(false);
    // Neither file may be touched by a refused rename.
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello\n");
  });

  test("renaming to the same path is a no-op, not a collision", async () => {
    const same = join(dir, "a.txt");
    const r = await fs.rename(same, same);
    expect(r.ok).toBe(true);
    expect(await readFile(same, "utf8")).toBe("hello\n");
  });

  test("moves into a directory that does not exist yet", async () => {
    const to = join(dir, "moved", "a.txt");
    expect((await fs.rename(join(dir, "a.txt"), to)).ok).toBe(true);
    expect(await readFile(to, "utf8")).toBe("hello\n");
  });
});

describe("duplicate", () => {
  test("copies beside the original", async () => {
    const r = await fs.duplicate(join(dir, "a.txt"));
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(dir, "a copy.txt"));
    expect(await readFile(r.path!, "utf8")).toBe("hello\n");
    // The original is untouched.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello\n");
  });

  test("the suffix goes before the extension, so the type is preserved", async () => {
    await writeFile(join(dir, "notes.md"), "# hi\n");
    const r = await fs.duplicate(join(dir, "notes.md"));
    expect(r.path!.endsWith(".md")).toBe(true);
    expect(r.path).toContain("notes copy");
  });

  test("repeated duplicates keep finding free names", async () => {
    const first = await fs.duplicate(join(dir, "a.txt"));
    const second = await fs.duplicate(join(dir, "a.txt"));
    expect(first.path).not.toBe(second.path);
    expect(second.path).toBe(join(dir, "a copy 2.txt"));
  });

  test("preserves the file mode", async () => {
    const exec = join(dir, "run.sh");
    await writeFile(exec, "#!/bin/sh\n", { mode: 0o755 });
    const r = await fs.duplicate(exec);
    expect(((await stat(r.path!)).mode & 0o777)).toBe(0o755);
  });

  test("a folder is refused rather than silently half-copied", async () => {
    await mkdir(join(dir, "folder"));
    expect((await fs.duplicate(join(dir, "folder"))).ok).toBe(false);
  });

  test("a missing file is an error, not a throw", async () => {
    expect((await fs.duplicate(join(dir, "ghost.txt"))).ok).toBe(false);
  });
});
