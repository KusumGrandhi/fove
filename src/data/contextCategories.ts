/**
 * What is actually in the prompt, by category -- reconstructed from the
 * session's own transcript.
 *
 * This replaces guessing from disk. An earlier attempt measured the skills,
 * memory and agent directories and was wildly wrong: 96 SKILL.md files on the
 * machine against 41 in the session, every project's memory summed together
 * against one project's, whole agent files against their description lines.
 * The scoping rules were unknowable from outside.
 *
 * They do not have to be knowable, because the CLI writes what it injected.
 * Alongside the user and assistant turns, a transcript carries `attachment`
 * records describing every block of text added to the prompt:
 *
 *   skill_listing        the skill catalogue, with a count
 *   instructions         CLAUDE.md and memory files, path and content
 *   agent_listing_delta  the custom-agent roster
 *   deferred_tools_delta tool names, added and removed, one line each
 *   deferred_tools_record full schemas for tools actually pulled in
 *   mcp_instructions_delta per-server usage notes
 *
 * So these are measurements of this session, not estimates of a machine.
 *
 * Two things are still estimates and are labelled as such everywhere they
 * surface: bytes become tokens at the usual 4:1, and the system prompt itself
 * is never written to disk in any form -- searching a 71MB transcript for it
 * returns nothing. It is real, it is large, and it is not here.
 *
 * Deltas, not snapshots. Most of these records describe a change rather than a
 * state, so the current content is the fold of every record in file order --
 * which is why this is an accumulator fed one record at a time rather than a
 * function over the last one.
 */

import type { TranscriptRecord } from "./types.js";

/** One row of the breakdown. */
export interface CategoryTally {
  /** Bytes of text this category has in the prompt right now. */
  bytes: number;
  /** How many things that is -- skills, files, tools. */
  count: number;
}

export interface ContextCategories {
  skills: CategoryTally;
  memory: CategoryTally;
  agents: CategoryTally;
  /** Tools reached through an MCP server, by the `mcp__server__tool` naming. */
  mcpTools: CategoryTally;
  /** Everything else offered to the model: the CLI's own tools. */
  builtinTools: CategoryTally;
  /** Full schemas for tools that were actually loaded, not just offered. */
  toolSchemas: CategoryTally;
  /** Per-server usage notes an MCP server asks to be shown. */
  mcpInstructions: CategoryTally;
}

const empty = (): CategoryTally => ({ bytes: 0, count: 0 });

export function emptyCategories(): ContextCategories {
  return {
    skills: empty(), memory: empty(), agents: empty(),
    mcpTools: empty(), builtinTools: empty(),
    toolSchemas: empty(), mcpInstructions: empty(),
  };
}

/** Total bytes across every category, for the "accounted for" line. */
export function totalBytes(c: ContextCategories): number {
  return Object.values(c).reduce((n, t) => n + t.bytes, 0);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export class CategoryAccumulator {
  /*
   * Tools are tracked by name rather than as a running byte count, because
   * they are removed as well as added and a bare total cannot be un-added.
   * `addedLines` runs parallel to `addedNames` (verified: 316 and 316), so
   * each name keeps the size of its own line and a removal subtracts exactly
   * what that name contributed.
   */
  private readonly toolLines = new Map<string, number>();
  /** Agent roster, same add/remove problem, same fix. */
  private readonly agentLines = new Map<string, number>();
  private readonly mcpBlocks = new Map<string, number>();

  private skills = empty();
  private memory = empty();
  private schemas = empty();

  /** Fold one transcript record in. Anything unrecognised is ignored. */
  add(rec: TranscriptRecord): void {
    if (rec.type !== "attachment") return;
    const a = rec.attachment as Record<string, unknown> | undefined;
    if (!a || typeof a.type !== "string") return;

    switch (a.type) {
      /*
       * The catalogue every session carries: one line per skill, name and
       * description only -- a skill's body is read when it is invoked, and
       * never appears here. `isInitial` marks a full listing; anything else
       * adds to it.
       */
      case "skill_listing": {
        const bytes = str(a.content).length;
        const count = num(a.skillCount) || arr(a.names).length;
        if (a.isInitial === true) this.skills = { bytes, count };
        else this.skills = { bytes: this.skills.bytes + bytes, count: this.skills.count + count };
        break;
      }

      /*
       * CLAUDE.md and the memory index, restated in full each time rather
       * than as a delta -- so the newest record replaces rather than adds.
       */
      case "instructions": {
        const files = arr(a.files) as Record<string, unknown>[];
        this.memory = {
          bytes: files.reduce((n, f) => n + str(f.content).length, 0),
          count: files.length,
        };
        break;
      }

      case "agent_listing_delta": {
        if (a.isInitial === true) this.agentLines.clear();
        this.foldLines(this.agentLines, arr(a.addedTypes), arr(a.addedLines), arr(a.removedTypes));
        break;
      }

      case "deferred_tools_delta": {
        this.foldLines(
          this.toolLines,
          // `readdedNames` re-offers a tool that was withdrawn earlier; it
          // carries no lines of its own, so it re-uses whatever is already
          // recorded for that name.
          [...arr(a.addedNames), ...arr(a.readdedNames)],
          arr(a.addedLines),
          arr(a.removedNames),
        );
        break;
      }

      /*
       * A schema arrives only once a tool is actually pulled into context,
       * which is the difference between the hundreds of tools *offered* and
       * the handful that cost their full description and input schema.
       */
      case "deferred_tools_record": {
        const entries = arr(a.entries) as Record<string, unknown>[];
        this.schemas = {
          bytes: this.schemas.bytes + entries.reduce((n, e) => n + JSON.stringify(e).length, 0),
          count: this.schemas.count + entries.length,
        };
        break;
      }

      case "mcp_instructions_delta": {
        this.foldLines(this.mcpBlocks, arr(a.addedNames), arr(a.addedBlocks), arr(a.removedNames));
        break;
      }
    }
  }

  /**
   * Apply one add/remove pair to a name-keyed map.
   *
   * `lines` is positional against `names`; a name with no line still counts,
   * at whatever size it already had, so a re-add never silently drops to zero.
   */
  private foldLines(
    into: Map<string, number>,
    names: unknown[],
    lines: unknown[],
    removed: unknown[],
  ): void {
    names.forEach((n, i) => {
      const name = str(n);
      if (!name) return;
      const line = i < lines.length ? str(lines[i]).length : (into.get(name) ?? 0);
      into.set(name, line);
    });
    for (const r of removed) into.delete(str(r));
  }

  get current(): ContextCategories {
    const tally = (m: Map<string, number>): CategoryTally => ({
      bytes: [...m.values()].reduce((n, b) => n + b, 0),
      count: m.size,
    });
    // Split by the `mcp__server__tool` naming the CLI uses -- the only thing
    // distinguishing a server's tool from one of the CLI's own.
    const mcp = new Map([...this.toolLines].filter(([n]) => n.startsWith("mcp__")));
    const builtin = new Map([...this.toolLines].filter(([n]) => !n.startsWith("mcp__")));
    return {
      skills: { ...this.skills },
      memory: { ...this.memory },
      agents: tally(this.agentLines),
      mcpTools: tally(mcp),
      builtinTools: tally(builtin),
      toolSchemas: { ...this.schemas },
      mcpInstructions: tally(this.mcpBlocks),
    };
  }
}
