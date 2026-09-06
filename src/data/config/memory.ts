/**
 * Memory files under ~/.claude/projects/<slug>/memory/.
 *
 * Read-only, with search. MEMORY.md is a hand-curated index -- this app never
 * rewrites it; that curation is the point.
 */

import { join } from "node:path";
import { readdir, stat, readFile } from "node:fs/promises";
import { PROJECTS_DIR } from "../transcript.js";

export interface MemoryFile {
  name: string;
  path: string;
  projectSlug: string;
  sizeBytes: number;
  mtimeMs: number;
  isIndex: boolean;
  description?: string;
}

/** Pull `description:` out of the frontmatter, if present. */
function describe(text: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return /^description:\s*(.*)$/m.exec(text.slice(0, end))?.[1]?.trim();
}

export async function listMemories(slug?: string): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  let slugs: string[];
  try {
    slugs = slug ? [slug] : await readdir(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const s of slugs) {
    const dir = join(PROJECTS_DIR, s, "memory");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      try {
        const st = await stat(path);
        if (!st.isFile()) continue;
        let description: string | undefined;
        if (st.size < 64_000) description = describe(await readFile(path, "utf8"));
        out.push({
          name: f,
          path,
          projectSlug: s,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          isIndex: f === "MEMORY.md",
          description,
        });
      } catch {
        // Unreadable: skip.
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Case-insensitive match over name, description, and project. */
export function filterMemories(files: MemoryFile[], q: string): MemoryFile[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return files;
  return files.filter((f) =>
    `${f.name} ${f.description ?? ""} ${f.projectSlug}`.toLowerCase().includes(needle),
  );
}
