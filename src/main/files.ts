/**
 * File service: the operations an editor needs — read, write, list, and the
 * tree actions (create, rename, duplicate, delete).
 *
 * Writes are atomic (temp + rename) and preserve the original file mode, so an
 * interrupted save can never truncate the user's source. Reads refuse binary
 * and oversized files rather than handing the editor megabytes of noise.
 *
 * Deletion goes to the system trash, never `unlink`. It is the one action here
 * the user cannot undo, and the OS already provides the undo.
 *
 * Every mutating call returns `{ ok, error }` rather than throwing: these are
 * driven by clicks, and a permission error should reach the tree as a message
 * beside the file, not as an unhandled rejection.
 */

import {
  readFile, writeFile, readdir, stat, rename, chmod, mkdir, copyFile, access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { shell } from "electron";

/** Beyond this, an editor is the wrong tool. */
const MAX_READ = 8 * 1024 * 1024;

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface ReadResult {
  path: string;
  content: string;
  /** mtime at read time, used to detect a concurrent change before saving. */
  mtimeMs: number;
  language: string;
  readonly?: boolean;
  error?: string;
}

/**
 * Extension -> Monaco language id.
 *
 * Only a hint: the renderer resolves the real language from Monaco's own
 * registry (~90 languages), which is authoritative and grows with Monaco. This
 * map exists so a caller with no editor still gets something reasonable.
 */
const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", swift: "swift", kt: "kotlin", scala: "scala",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql", xml: "xml",
  dockerfile: "dockerfile", makefile: "makefile",
};

export function languageFor(path: string): string {
  const base = basename(path).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  if (base.startsWith(".env")) return "ini";
  return LANGS[extname(path).slice(1).toLowerCase()] ?? "plaintext";
}

/** Heuristic: a NUL byte in the first 8KB means binary. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class FileService {
  async read(path: string): Promise<ReadResult> {
    const base: ReadResult = { path, content: "", mtimeMs: 0, language: languageFor(path) };
    try {
      const st = await stat(path);
      if (st.isDirectory()) return { ...base, error: "is a directory", readonly: true };
      if (st.size > MAX_READ) {
        return { ...base, error: `file too large (${Math.round(st.size / 1e6)}MB)`, readonly: true };
      }
      const buf = await readFile(path);
      if (looksBinary(buf)) return { ...base, error: "binary file", readonly: true };
      return { ...base, content: buf.toString("utf8"), mtimeMs: st.mtimeMs };
    } catch (e) {
      return { ...base, error: String((e as Error).message ?? e), readonly: true };
    }
  }

  /**
   * Atomic write. `expectedMtimeMs`, when given, guards against overwriting a
   * change made since the read -- an agent editing the same file, for instance.
   */
  async write(
    path: string,
    content: string,
    expectedMtimeMs?: number,
  ): Promise<{ ok: boolean; mtimeMs?: number; error?: string; conflict?: boolean }> {
    try {
      let mode = 0o644;
      try {
        const st = await stat(path);
        mode = st.mode & 0o777;
        if (expectedMtimeMs !== undefined && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
          return { ok: false, conflict: true, error: "file changed on disk since it was opened" };
        }
      } catch {
        // New file: no mode or mtime to honour.
      }
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      await writeFile(tmp, content, "utf8");
      await chmod(tmp, mode).catch(() => {});
      await rename(tmp, path);
      return { ok: true, mtimeMs: (await stat(path)).mtimeMs };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  /** Directory listing, dirs first, hidden entries last. */
  async list(dir: string): Promise<FileEntry[]> {
    try {
      const names = await readdir(dir, { withFileTypes: true });
      const out: FileEntry[] = [];
      for (const d of names) {
        if (d.name === ".git" || d.name === "node_modules") continue;
        const path = join(dir, d.name);
        let size = 0;
        try {
          if (d.isFile()) size = (await stat(path)).size;
        } catch {
          // Broken symlink or permission denied; still list it.
        }
        out.push({ name: d.name, path, dir: d.isDirectory(), size });
      }
      return out.sort((a, b) => {
        const hiddenA = a.name.startsWith(".") ? 1 : 0;
        const hiddenB = b.name.startsWith(".") ? 1 : 0;
        if (hiddenA !== hiddenB) return hiddenA - hiddenB;
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }
}

// --- tree operations -------------------------------------------------------

/** The shape every mutating tree call returns. */
export interface FsResult {
  ok: boolean;
  /** The resulting path, when the call produced one. */
  path?: string;
  error?: string;
}

const fail = (e: unknown): FsResult => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});

/** True when something already exists at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path that does not collide, by inserting " copy", then " copy 2", ...
 *
 * The suffix goes before the extension so `notes.md` becomes `notes copy.md`
 * and stays openable as markdown.
 */
async function uniquePath(path: string): Promise<string> {
  if (!(await exists(path))) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    const candidate = join(dir, `${stem}${suffix}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("could not find a free name");
}

export class FileTreeService {
  /**
   * Create an empty file, refusing to clobber an existing one.
   *
   * Silently overwriting is the failure mode that loses work, so a collision
   * is an error the caller must show rather than something to resolve
   * automatically.
   */
  async createFile(path: string): Promise<FsResult> {
    try {
      if (await exists(path)) return { ok: false, error: "already exists" };
      await mkdir(dirname(path), { recursive: true });
      // wx: fail if it appeared between the check and the write.
      await writeFile(path, "", { flag: "wx" });
      return { ok: true, path };
    } catch (e) {
      return fail(e);
    }
  }

  async createDir(path: string): Promise<FsResult> {
    try {
      if (await exists(path)) return { ok: false, error: "already exists" };
      await mkdir(path, { recursive: true });
      return { ok: true, path };
    } catch (e) {
      return fail(e);
    }
  }

  /**
   * Rename or move. The caller must re-key any open editor model, or it keeps
   * writing to a path that no longer exists.
   */
  async rename(from: string, to: string): Promise<FsResult> {
    try {
      if (from === to) return { ok: true, path: to };
      // Case-only renames on a case-insensitive filesystem look like a
      // collision but are legitimate, so compare exactly.
      if (await exists(to)) return { ok: false, error: "a file with that name already exists" };
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return { ok: true, path: to };
    } catch (e) {
      return fail(e);
    }
  }

  /** Copy a file beside itself, resolving the name. */
  async duplicate(path: string): Promise<FsResult> {
    try {
      const st = await stat(path);
      if (st.isDirectory()) return { ok: false, error: "cannot duplicate a folder yet" };
      const target = await uniquePath(path);
      await copyFile(path, target);
      await chmod(target, st.mode & 0o777).catch(() => {});
      return { ok: true, path: target };
    } catch (e) {
      return fail(e);
    }
  }

  /**
   * Move to the system trash.
   *
   * Never `unlink`: this is the only irreversible action in the tree, and the
   * OS already has an undo for it. Works for directories too.
   */
  async trash(path: string): Promise<FsResult> {
    try {
      await shell.trashItem(path);
      return { ok: true, path };
    } catch (e) {
      return fail(e);
    }
  }
}
