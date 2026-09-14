/**
 * Format on save.
 *
 * The rule worth guarding mechanically is the restraint one: a project that
 * has not asked for a formatter must not get one. The rest -- does prettier
 * indent correctly -- is prettier's own test suite, not this one's.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FormatService } from "../src/main/format.js";

const run = promisify(execFile);
let dir: string;

/** See lint.test.ts: probed at collection time so `runIf` can see it. */
const haveRuff = await run("ruff", ["--version"]).then(() => true, () => false);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-format-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FormatService", () => {
  test("a file type nothing here formats is left alone", async () => {
    const svc = new FormatService();
    const r = await svc.run(join(dir, "notes.txt"), "  ragged   \n", dir);
    expect(r.content).toBeNull();
    expect(r.by).toBeUndefined();
  });

  test("a project with no prettier of its own gets no formatting", async () => {
    // The critical case: a global prettier must not reformat a repository
    // that never asked for one.
    const bare = join(dir, "bare");
    await mkdir(bare, { recursive: true });
    const svc = new FormatService();
    const r = await svc.run(join(bare, "a.ts"), "const x   =1\n", bare);
    expect(r.content).toBeNull();
  });

  test("the project's own prettier is found by walking up from the file", async () => {
    /*
     * A monorepo keeps its tooling at the top and its packages below, so the
     * search must not stop at the directory the file is in. A stub stands in
     * for prettier: what is under test is the resolution, not the tool.
     */
    const repo = join(dir, "repo");
    const pkg = join(repo, "packages", "web", "src");
    const bin = join(repo, "node_modules", ".bin");
    await mkdir(pkg, { recursive: true });
    await mkdir(bin, { recursive: true });
    const stub = join(bin, "prettier");
    await writeFile(stub, "#!/bin/sh\nsed 's/  */ /g'\n");
    await chmod(stub, 0o755);

    const svc = new FormatService();
    const r = await svc.run(join(pkg, "a.ts"), "const    x = 1\n", pkg);
    expect(r.by).toBe("prettier");
    expect(r.content).toBe("const x = 1\n");
  });

  test("a formatter that fails reports why and changes nothing", async () => {
    const repo = join(dir, "broken");
    const bin = join(repo, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const stub = join(bin, "prettier");
    await writeFile(stub, "#!/bin/sh\necho 'a.ts: Unexpected token (1:7)' >&2\nexit 2\n");
    await chmod(stub, 0o755);

    const svc = new FormatService();
    const r = await svc.run(join(repo, "a.ts"), "const = = 1\n", repo);
    expect(r.content).toBeNull();
    expect(r.error).toContain("Unexpected token");
  });

  test.runIf(haveRuff)("python goes through ruff", async () => {
    const svc = new FormatService();
    const r = await svc.run(join(dir, "a.py"), "x = {  'a':1 }\n", dir);
    expect(r.by).toBe("ruff");
    expect(r.content).toBe('x = {"a": 1}\n');
  });
});
