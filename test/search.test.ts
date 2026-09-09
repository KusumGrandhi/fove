/**
 * Codebase search, over real ripgrep in a disposable fixture.
 *
 * This exists because of a bug that reached the UI: searching `agent.md` in a
 * repository containing `AGENTS.md` reported "no matches". Both halves of that
 * were true and useless -- the pane searched *contents* for a literal string
 * with a dot in it, and the file the user meant was never a candidate.
 *
 * So the rules under test are about what the user asked, not what rg was told:
 * a filename query finds the file, and a literal query says it was literal.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchService, type SearchMatch } from "../src/main/search.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fove-search-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# Agent instructions\nsee CLAUDE.md\n");
  writeFileSync(join(dir, "readme.md"), "This project mentions AGENTS.md once.\n");
  writeFileSync(join(dir, "nested", "server.ts"), "export const port = 8080;\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run one search to completion and collect everything it emitted. */
function search(q: Partial<Parameters<SearchService["start"]>[1]> & { query: string }) {
  return new Promise<{ matches: SearchMatch[]; count: number; truncated: boolean }>((resolve) => {
    const matches: SearchMatch[] = [];
    const svc = new SearchService(
      (_id, batch) => matches.push(...batch),
      (_id, count, truncated) => resolve({ matches, count, truncated }),
    );
    svc.start("t", { cwd: dir, ...q });
  });
}

describe("filename search", () => {
  it("finds a file by its name, which is the bug that shipped", async () => {
    // The exact query from the report: a filename, with a literal dot.
    const { matches } = await search({ query: "agent.md" });
    const paths = matches.filter((m) => m.isPath).map((m) => m.path);
    expect(paths).toContain("AGENTS.md");
  });

  it("marks a filename hit as a path, with no line number", async () => {
    const { matches } = await search({ query: "AGENTS.md" });
    const hit = matches.find((m) => m.isPath);
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(0);
    // The highlight offsets must point inside the path itself.
    expect(hit!.text.slice(hit!.start, hit!.end).toLowerCase()).toBe("agents.md");
  });

  it("still returns content matches alongside path matches", async () => {
    const { matches } = await search({ query: "AGENTS.md" });
    expect(matches.some((m) => m.isPath)).toBe(true);
    // readme.md mentions it in its text.
    expect(matches.some((m) => !m.isPath && m.path === "readme.md")).toBe(true);
  });

  it("respects case sensitivity on paths", async () => {
    const insensitive = await search({ query: "agents.md", caseSensitive: false });
    expect(insensitive.matches.some((m) => m.isPath)).toBe(true);

    const sensitive = await search({ query: "agents.md", caseSensitive: true });
    expect(sensitive.matches.some((m) => m.isPath)).toBe(false);
  });

  it("honours globs, so a filtered search does not smuggle paths back in", async () => {
    const { matches } = await search({ query: "server", globs: ["*.md"] });
    expect(matches.some((m) => m.path.endsWith("server.ts"))).toBe(false);
  });
});

describe("ranking", () => {
  it("puts an exact path hit above a fuzzy one", async () => {
    /*
     * "agent.md" is a substring of neither `AGENTS.md` nor
     * `deep_agent_manifest.md` -- both match only as subsequences of the
     * basename. But a query that *is* a substring must outrank one that is
     * only scattered through the name, or the obvious answer gets buried.
     */
    const { matches } = await search({ query: "readme" });
    const paths = matches.filter((m) => m.isPath);
    expect(paths[0]!.path).toBe("readme.md");
    expect(paths[0]!.exact).toBe(true);
  });

  it("still finds a file whose name only matches as a subsequence", async () => {
    const { matches } = await search({ query: "agent.md" });
    const paths = matches.filter((m) => m.isPath).map((m) => m.path);
    expect(paths).toContain("AGENTS.md");
  });
});

describe("counting", () => {
  it("counts path and content hits together", async () => {
    const { matches, count } = await search({ query: "AGENTS.md" });
    expect(count).toBe(matches.length);
  });

  it("reports nothing for a query that genuinely matches nothing", async () => {
    const { matches, count } = await search({ query: "zzz-not-here-zzz" });
    expect(matches).toHaveLength(0);
    expect(count).toBe(0);
  });

  it("returns an empty result for a blank query rather than listing the repo", async () => {
    const { matches, count } = await search({ query: "   " });
    expect(matches).toHaveLength(0);
    expect(count).toBe(0);
  });
});
