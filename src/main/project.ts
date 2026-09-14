/**
 * The TypeScript sources a project is made of, for cross-file navigation.
 *
 * Monaco ships a real TypeScript language service in a worker -- the same one
 * VS Code uses -- and it resolves imports, finds references and renames
 * symbols across a whole program. It had none of that here for one reason:
 * it only ever saw the single file that was open. A language service with a
 * program of one file can no more find a definition in another file than it
 * could find one on another machine.
 *
 * So this hands it the program. Two kinds of file go in:
 *
 *   - the project's own sources, from `git ls-files`, which gets `.gitignore`
 *     handling for free and is fast on a large repository;
 *   - the type declarations of the project's *direct* dependencies, so that
 *     `import { useState } from "react"` resolves to something. Without them
 *     every bare import is an error, and turning the resulting red squiggles
 *     off would also turn off the diagnostics worth having.
 *
 * Everything here is capped. A language service that has read a 400MB
 * monorepo is not more useful than one that has read the first 12MB of it; it
 * is just an editor that took a minute to open. What was dropped is reported
 * rather than hidden, so the pane can say so.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const run = promisify(execFile);

/** Extensions the TypeScript service can do anything with. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);

/*
 * Byte budgets.
 *
 * Doubled in practice: the renderer hands this text to both the TypeScript
 * and the JavaScript worker, since a project is usually a mix and each worker
 * serves its own file types. So these are half of what the app will actually
 * hold, which is what keeps them this modest.
 */
const LIMITS = {
  /** Total bytes of project source. */
  sourceBytes: 8 * 1024 * 1024,
  /** Total bytes of dependency typings, which are the easier thing to blow. */
  typingBytes: 6 * 1024 * 1024,
  /** Per file, so one generated bundle cannot eat the whole budget. */
  fileBytes: 2 * 1024 * 1024,
  /** Depth to walk inside one dependency looking for declarations. */
  typingDepth: 6,
};

export interface ProjectFile {
  path: string;
  content: string;
}

export interface ProjectSources {
  files: ProjectFile[];
  /** Files found but not read, because a cap was reached. */
  skipped: number;
  /** Whether the project has a tsconfig, which decides how strict to be. */
  hasTsConfig: boolean;
  /** Its text, for the compiler options that decide what resolves. */
  tsconfig: { path: string; text: string } | null;
}

/** Read a batch of files without opening thousands of handles at once. */
async function readAll(
  paths: string[],
  budget: number,
): Promise<{ files: ProjectFile[]; skipped: number }> {
  const files: ProjectFile[] = [];
  let used = 0;
  let skipped = 0;

  for (let i = 0; i < paths.length; i += 32) {
    if (used >= budget) { skipped += paths.length - i; break; }
    const batch = await Promise.all(
      paths.slice(i, i + 32).map(async (path) => {
        try {
          const info = await stat(path);
          if (info.size > LIMITS.fileBytes) return null;
          return { path, content: await readFile(path, "utf8") };
        } catch {
          // Deleted between listing and reading, or not readable. Neither is
          // worth failing the whole load over.
          return null;
        }
      }),
    );
    for (const f of batch) {
      if (!f) { skipped++; continue; }
      if (used + f.content.length > budget) { skipped++; continue; }
      used += f.content.length;
      files.push(f);
    }
  }
  return { files, skipped };
}

/** Every `.d.ts` under a directory, bounded in depth and in count. */
async function declarationsUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > LIMITS.typingDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    // A dependency's own dependencies are somebody else's problem: they are
    // reached through the package that re-exports them, and walking into them
    // is how a typings load becomes a gigabyte.
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".bin") continue;
      out.push(...await declarationsUnder(join(dir, e.name), depth + 1));
    } else if (e.name.endsWith(".d.ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

export class ProjectService {
  /** One load per root, since the result feeds a worker that keeps it. */
  private readonly cache = new Map<string, Promise<ProjectSources>>();

  sources(root: string): Promise<ProjectSources> {
    const cached = this.cache.get(root);
    if (cached) return cached;
    const p = this.load(root);
    this.cache.set(root, p);
    return p;
  }

  /** Drop the memo, so a reload picks up files added since. */
  invalidate(root: string): void {
    this.cache.delete(root);
  }

  private async load(root: string): Promise<ProjectSources> {
    const tracked = await this.trackedSources(root);
    const source = await readAll(tracked, LIMITS.sourceBytes);

    const typingPaths = await this.dependencyTypings(root);
    const typings = await readAll(typingPaths, LIMITS.typingBytes);

    const tsconfig = await this.findTsConfig(root);

    return {
      files: [...source.files, ...typings.files],
      skipped: source.skipped + typings.skipped,
      hasTsConfig: tsconfig !== null,
      tsconfig,
    };
  }

  /**
   * The project's TypeScript config.
   *
   * `tsconfig.json` if there is one, and otherwise the first `tsconfig.*.json`
   * -- a project split into `tsconfig.main.json` and `tsconfig.renderer.json`
   * with no plain one at the root is a real and common shape (fove is one),
   * and reading only the canonical name would decide such a project has no
   * TypeScript configuration at all and silently turn type-checking off.
   */
  private async findTsConfig(root: string): Promise<{ path: string; text: string } | null> {
    const read = async (name: string) => {
      const path = join(root, name);
      try {
        return { path, text: await readFile(path, "utf8") };
      } catch {
        return null;
      }
    };

    const canonical = await read("tsconfig.json");
    if (canonical) return canonical;

    try {
      const variant = (await readdir(root))
        .filter((n) => /^tsconfig\..+\.json$/.test(n))
        .sort()[0];
      return variant ? await read(variant) : null;
    } catch {
      return null;
    }
  }

  /**
   * The project's own source files.
   *
   * `git ls-files` rather than a walk: it honours `.gitignore` without
   * reimplementing it, which is the difference between reading a project and
   * reading its `dist/` and `node_modules/` as well.
   */
  private async trackedSources(root: string): Promise<string[]> {
    try {
      const { stdout } = await run("git", ["ls-files", "-z"], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout
        .split("\0")
        .filter((p) => p && SOURCE_EXTENSIONS.has(extname(p)))
        .map((p) => join(root, p));
    } catch {
      // Not a git repository, or git is unavailable. Navigation within the
      // open files still works; it just does not reach the rest of the tree.
      return [];
    }
  }

  /**
   * Declarations for the dependencies the project itself names.
   *
   * Direct dependencies only, from package.json. A transitive dependency's
   * types are reachable through whichever direct one re-exports them, and
   * walking the whole tree is both enormous and mostly noise.
   */
  private async dependencyTypings(root: string): Promise<string[]> {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    } catch {
      return [];
    }

    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    // `@types/*` packages are what a dependency without its own declarations
    // is typed by, and nothing in package.json necessarily names them.
    let typesPackages: string[] = [];
    try {
      typesPackages = (await readdir(join(root, "node_modules", "@types")))
        .map((n) => `@types/${n}`);
    } catch {
      typesPackages = [];
    }

    const dirs = [...new Set([...names, ...typesPackages])]
      .map((n) => join(root, "node_modules", n));

    const found = await Promise.all(dirs.map((d) => declarationsUnder(d)));
    return found.flat();
  }
}
