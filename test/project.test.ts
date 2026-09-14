/**
 * The project the language service is given.
 *
 * What is worth guarding here is the boundary behaviour: that the caps hold,
 * that a project whose TypeScript config is not called `tsconfig.json` is
 * still recognised as a TypeScript project, and that none of it throws on a
 * directory that is not a repository.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectService } from "../src/main/project.js";

const run = promisify(execFile);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-project-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A throwaway git repo with the given files committed. */
async function repo(name: string, files: Record<string, string>): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: root });
  return root;
}

describe("ProjectService", () => {
  test("reads the tracked sources and ignores everything else", async () => {
    const root = await repo("plain", {
      "src/a.ts": "export const a = 1;\n",
      "src/b.tsx": "export const b = <div />;\n",
      "README.md": "# not a source file\n",
      "src/data.json": "{}\n",
    });
    const r = await new ProjectService().sources(root);
    const names = r.files.map((f) => f.path.replace(root + "/", "")).sort();
    expect(names).toEqual(["src/a.ts", "src/b.tsx"]);
    expect(r.skipped).toBe(0);
  });

  test("an untracked file is not part of the project", async () => {
    // .gitignore handling comes free with `git ls-files`, and this is the
    // check that it is actually being relied on rather than reimplemented.
    const root = await repo("ignored", {
      "src/a.ts": "export const a = 1;\n",
      ".gitignore": "dist/\n",
    });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "var x = 1;\n");

    const r = await new ProjectService().sources(root);
    expect(r.files.map((f) => f.path)).not.toContain(join(root, "dist", "bundle.js"));
  });

  test("a split tsconfig still counts as a TypeScript project", async () => {
    /*
     * The case that caught this out: fove itself has tsconfig.main.json and
     * tsconfig.renderer.json and no plain tsconfig.json, and reading only the
     * canonical name decided it had no TypeScript configuration at all --
     * which silently turned semantic diagnostics off for the whole project.
     */
    const root = await repo("split", {
      "src/a.ts": "export const a = 1;\n",
      "tsconfig.main.json": '{ "compilerOptions": { "strict": true } }\n',
      "tsconfig.renderer.json": '{ "compilerOptions": { "jsx": "react-jsx" } }\n',
    });
    const r = await new ProjectService().sources(root);
    expect(r.hasTsConfig).toBe(true);
    expect(r.tsconfig?.path.endsWith("tsconfig.main.json")).toBe(true);
  });

  test("a plain tsconfig.json wins over the variants", async () => {
    const root = await repo("canonical", {
      "src/a.ts": "export const a = 1;\n",
      "tsconfig.json": '{ "compilerOptions": {} }\n',
      "tsconfig.build.json": '{ "compilerOptions": {} }\n',
    });
    const r = await new ProjectService().sources(root);
    expect(r.tsconfig?.path.endsWith("tsconfig.json")).toBe(true);
  });

  test("no tsconfig at all is reported honestly", async () => {
    const root = await repo("js-only", { "index.js": "module.exports = 1;\n" });
    const r = await new ProjectService().sources(root);
    expect(r.hasTsConfig).toBe(false);
    expect(r.tsconfig).toBeNull();
  });

  test("a directory that is not a repository yields nothing, not an error", async () => {
    const bare = join(dir, "bare");
    await mkdir(bare, { recursive: true });
    const r = await new ProjectService().sources(bare);
    expect(r.files).toEqual([]);
    expect(r.hasTsConfig).toBe(false);
  });

  test("the result is memoised, and invalidate clears it", async () => {
    const root = await repo("memo", { "a.ts": "export const a = 1;\n" });
    const svc = new ProjectService();
    const first = await svc.sources(root);
    expect(await svc.sources(root)).toBe(first);
    svc.invalidate(root);
    expect(await svc.sources(root)).not.toBe(first);
  });
});
