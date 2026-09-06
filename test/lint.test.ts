/**
 * Diagnostics. Skipped when ruff is absent rather than failing: it is a real
 * dependency on the machine, not something vendored with the app.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LintService } from "../src/main/lint.js";

const run = promisify(execFile);
let dir: string;
const svc = new LintService();

/**
 * Probed at collection time, not in beforeAll: `test.runIf` is evaluated when
 * the file is collected, so a flag set later is always still false and every
 * ruff test would silently skip.
 */
const haveRuff = await run("ruff", ["--version"]).then(() => true, () => false);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-lint-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LintService", () => {
  test("a language with no linter reports nothing, rather than erroring", async () => {
    const f = join(dir, "a.ts");
    await writeFile(f, "const x = 1\n");
    expect(await svc.check(f)).toEqual([]);
  });

  test("a missing file does not throw", async () => {
    expect(await svc.check(join(dir, "ghost.py"))).toEqual([]);
  });

  test.runIf(haveRuff)("finds an unused import, with a usable range", async () => {
    const f = join(dir, "bad.py");
    await writeFile(f, "import os\n\ndef f(x):\n    return x\n");
    const diags = await svc.check(f);
    const unused = diags.find((d) => d.code === "F401");
    expect(unused).toBeDefined();
    expect(unused!.line).toBe(1);
    // Monaco needs a range it can underline.
    expect(unused!.endColumn).toBeGreaterThan(unused!.column);
    expect(unused!.message).toContain("os");
  });

  test.runIf(haveRuff)("a clean file has no diagnostics", async () => {
    const f = join(dir, "clean.py");
    await writeFile(f, "def f(x):\n    return x\n");
    expect(await svc.check(f)).toEqual([]);
  });

  test.runIf(haveRuff)("an undefined name is an error, not a style note", async () => {
    const f = join(dir, "undef.py");
    await writeFile(f, "def f():\n    return not_defined_anywhere\n");
    const diags = await svc.check(f);
    const f821 = diags.find((d) => d.code === "F821");
    expect(f821?.severity).toBe("error");
  });
});
