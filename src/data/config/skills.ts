/**
 * Skill discovery and cost accounting.
 *
 * Only a skill's frontmatter (name + description) enters the system prompt on
 * every session; the SKILL.md body loads on demand. So the standing cost of a
 * skill is its frontmatter size, and its value is how often it is actually
 * invoked. Sorting by cost-per-use is the view Claude Code does not offer.
 *
 * Note: ~/.claude/skills/<name>/SKILL.md is frequently a symlink into a bundle
 * (e.g. gstack). Symlinks are resolved for reading, and the bundle directory
 * must never be moved -- doing so breaks every skill that links into it.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readlink, stat, readFile } from "node:fs/promises";
import type { SkillUsage } from "./claudeJson.js";

export const USER_SKILLS_DIR = join(homedir(), ".claude", "skills");

export interface SkillInfo {
  name: string;
  path: string;
  /** Resolved target when SKILL.md is a symlink (e.g. a gstack bundle). */
  linkTarget?: string;
  bundle?: string;
  description?: string;
  /** Bytes of YAML frontmatter -- the per-session context cost. */
  frontmatterBytes: number;
  usageCount: number;
  lastUsedAt?: number;
  /** Override state from settings.json, if any. */
  override?: "on" | "off" | "name-only" | "user-invocable-only";
}

/** Rough token estimate: ~4 chars per token. */
export const estTokens = (bytes: number): number => Math.round(bytes / 4);

/** Extract the YAML frontmatter block and the description field from it. */
export function parseFrontmatter(text: string): { bytes: number; description?: string } {
  if (!text.startsWith("---")) return { bytes: 0 };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { bytes: 0 };
  const block = text.slice(0, end + 4);
  const m = /^description:\s*(.*)$/m.exec(block);
  let description = m?.[1]?.trim();
  if (description?.startsWith("|") || description?.startsWith(">")) {
    // Block scalar: take the first non-empty continuation line.
    const after = block.slice(block.indexOf(m![0]) + m![0].length);
    description = after.split("\n").map((l) => l.trim()).find((l) => l && l !== "---");
  }
  description = description?.replace(/^["']|["']$/g, "");
  return { bytes: block.length, description };
}

export async function listSkills(opts: {
  dir?: string;
  usage?: Map<string, SkillUsage>;
  overrides?: Record<string, string>;
} = {}): Promise<SkillInfo[]> {
  const dir = opts.dir ?? USER_SKILLS_DIR;
  const out: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }

  for (const name of entries) {
    const skillMd = join(dir, name, "SKILL.md");
    try {
      const st = await stat(skillMd); // follows symlinks
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let linkTarget: string | undefined;
    let bundle: string | undefined;
    try {
      linkTarget = await readlink(skillMd);
      // ~/.claude/skills/gstack/<skill>/SKILL.md -> bundle "gstack"
      const m = /\/skills\/([^/]+)\//.exec(linkTarget);
      if (m && m[1] !== name) bundle = m[1];
    } catch {
      // Not a symlink.
    }

    let fm: { bytes: number; description?: string } = { bytes: 0 };
    try {
      fm = parseFrontmatter(await readFile(skillMd, "utf8"));
    } catch {
      // Unreadable: still list it, with zero cost.
    }
    const u = opts.usage?.get(name);
    out.push({
      name,
      path: skillMd,
      linkTarget,
      bundle,
      description: fm.description,
      frontmatterBytes: fm.bytes,
      usageCount: u?.usageCount ?? 0,
      lastUsedAt: u?.lastUsedAt,
      override: opts.overrides?.[name] as SkillInfo["override"],
    });
  }
  return out;
}

/**
 * Skills recorded as used but not found on disk under ~/.claude/skills.
 *
 * These are project skills, plugin/bundle skills, or built-ins. They cost no
 * user-scope frontmatter, but showing them keeps the usage picture honest --
 * several of the most-used skills on this machine live outside the user dir.
 */
export function orphanUsage(
  skills: SkillInfo[],
  usage: Map<string, SkillUsage>,
): { name: string; usageCount: number }[] {
  const known = new Set(skills.map((s) => s.name));
  return [...usage.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, u]) => ({ name, usageCount: u.usageCount }))
    .sort((a, b) => b.usageCount - a.usageCount);
}

export type SkillSort = "cost" | "usage" | "costPerUse" | "name";

/** Sort key: unused skills rank worst under costPerUse, by design. */
export function sortSkills(skills: SkillInfo[], by: SkillSort): SkillInfo[] {
  const copy = [...skills];
  switch (by) {
    case "cost":
      return copy.sort((a, b) => b.frontmatterBytes - a.frontmatterBytes);
    case "usage":
      return copy.sort((a, b) => b.usageCount - a.usageCount);
    case "costPerUse":
      return copy.sort(
        (a, b) =>
          b.frontmatterBytes / Math.max(1, b.usageCount) -
          a.frontmatterBytes / Math.max(1, a.usageCount),
      );
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Standing cost of one skill, by state.
 *
 * "off" and "user-invocable-only" send nothing. "name-only" sends the name and
 * not the description, so charging it the whole frontmatter -- as this did
 * before the state existed -- overstated it by roughly an order of magnitude
 * and made the cheap state look like it saved nothing. The two bytes cover the
 * list punctuation around the name; it is an estimate either way, but an
 * honest one.
 */
function standingBytes(s: SkillInfo): number {
  switch (s.override) {
    case "off":
    case "user-invocable-only":
      return 0;
    case "name-only":
      return s.name.length + 2;
    default:
      return s.frontmatterBytes;
  }
}

/** Total standing context cost of the skills that still send something. */
export function budget(skills: SkillInfo[]): { bytes: number; tokens: number; enabled: number } {
  const enabled = skills.filter((s) => standingBytes(s) > 0);
  const bytes = enabled.reduce((n, s) => n + standingBytes(s), 0);
  return { bytes, tokens: estTokens(bytes), enabled: enabled.length };
}
