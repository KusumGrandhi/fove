import { describe, expect, test, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat, readdir, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService, languageFor } from "../src/main/files.js";

const dirs: string[] = [];
const mk = async () => { const d = await mkdtemp(join(tmpdir(), "th-f-")); dirs.push(d); return d; };
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const fs = new FileService();

describe("languageFor", () => {
  test("maps common extensions to Monaco language ids", () => {
    expect(languageFor("/a/b.ts")).toBe("typescript");
    expect(languageFor("/a/b.tsx")).toBe("typescript");
    expect(languageFor("/a/b.py")).toBe("python");
    expect(languageFor("/a/b.md")).toBe("markdown");
    expect(languageFor("/a/b.yml")).toBe("yaml");
  });
  test("recognises extensionless files by name", () => {
    expect(languageFor("/a/Dockerfile")).toBe("dockerfile");
    expect(languageFor("/a/Makefile")).toBe("makefile");
    expect(languageFor("/a/.env.local")).toBe("ini");
  });
  test("falls back to plaintext", () => {
    expect(languageFor("/a/b.unknown")).toBe("plaintext");
    expect(languageFor("/a/noext")).toBe("plaintext");
  });
});

describe("read", () => {
  test("returns content, mtime and language", async () => {
    const d = await mk(); const p = join(d, "x.ts");
    await writeFile(p, "export const a = 1;\n");
    const r = await fs.read(p);
    expect(r.content).toBe("export const a = 1;\n");
    expect(r.language).toBe("typescript");
    expect(r.mtimeMs).toBeGreaterThan(0);
    expect(r.error).toBeUndefined();
  });
  test("refuses binary files instead of returning noise", async () => {
    const d = await mk(); const p = join(d, "img.bin");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const r = await fs.read(p);
    expect(r.error).toBe("binary file");
    expect(r.readonly).toBe(true);
  });
  test("refuses a directory", async () => {
    const d = await mk();
    expect((await fs.read(d)).error).toBe("is a directory");
  });
  test("reports a missing file rather than throwing", async () => {
    const r = await fs.read("/nonexistent/nope.ts");
    expect(r.error).toBeTruthy();
    expect(r.readonly).toBe(true);
  });
  test("preserves unicode", async () => {
    const d = await mk(); const p = join(d, "u.txt");
    await writeFile(p, "héllo — 世界 🎉");
    expect((await fs.read(p)).content).toBe("héllo — 世界 🎉");
  });
});

describe("write", () => {
  test("saves content and returns the new mtime", async () => {
    const d = await mk(); const p = join(d, "x.ts");
    await writeFile(p, "old");
    const r = await fs.write(p, "new");
    expect(r.ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("new");
    expect(r.mtimeMs).toBeGreaterThan(0);
  });
  test("creates a file that does not exist yet", async () => {
    const d = await mk(); const p = join(d, "fresh.ts");
    expect((await fs.write(p, "hi")).ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("hi");
  });
  test("preserves the file mode", async () => {
    const d = await mk(); const p = join(d, "x.sh");
    await writeFile(p, "#!/bin/sh\n", { mode: 0o755 });
    await fs.write(p, "#!/bin/sh\necho hi\n");
    expect((await stat(p)).mode & 0o777).toBe(0o755);
  });
  test("refuses to clobber a file changed since it was read", async () => {
    const d = await mk(); const p = join(d, "x.ts");
    await writeFile(p, "v1");
    const opened = await fs.read(p);
    // Something else (an agent, another editor) writes it.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(p, "v2-from-elsewhere");
    const r = await fs.write(p, "v3-from-editor", opened.mtimeMs);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(await readFile(p, "utf8")).toBe("v2-from-elsewhere"); // not clobbered
  });
  test("saves when the mtime still matches", async () => {
    const d = await mk(); const p = join(d, "x.ts");
    await writeFile(p, "v1");
    const opened = await fs.read(p);
    expect((await fs.write(p, "v2", opened.mtimeMs)).ok).toBe(true);
  });
  test("leaves no temp file behind", async () => {
    const d = await mk(); const p = join(d, "x.ts");
    await fs.write(p, "content");
    expect((await readdir(d)).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
  test("reports an unwritable path rather than throwing", async () => {
    expect((await fs.write("/nonexistent-dir/x.ts", "hi")).ok).toBe(false);
  });
});

describe("list", () => {
  test("dirs first, then files, hidden last", async () => {
    const d = await mk();
    await mkdir(join(d, "src"));
    await writeFile(join(d, "b.ts"), "");
    await writeFile(join(d, "a.ts"), "");
    await writeFile(join(d, ".hidden"), "");
    const names = (await fs.list(d)).map((e) => e.name);
    expect(names).toEqual(["src", "a.ts", "b.ts", ".hidden"]);
  });
  test("skips .git and node_modules", async () => {
    const d = await mk();
    await mkdir(join(d, ".git"));
    await mkdir(join(d, "node_modules"));
    await writeFile(join(d, "keep.ts"), "");
    expect((await fs.list(d)).map((e) => e.name)).toEqual(["keep.ts"]);
  });
  test("a missing directory yields nothing", async () => {
    expect(await fs.list("/nonexistent")).toEqual([]);
  });
});
