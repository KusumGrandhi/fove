/**
 * Intents: rules about a codebase, in English, that must stay true.
 *
 * Not what the code does -- that is documentation, and it rots. What it must
 * never *stop* doing. The thing said in review: *"you can't do that here,
 * because…"*, written where an agent can read it.
 *
 * Two commitments shape the format, and both came from getting it wrong first:
 *
 * **Prose is required, a mechanism is optional.** An earlier draft made a check
 * the entry ticket. That is backwards: it means five rules get written and the
 * ones that matter most never do, because *"error messages should say what to
 * do next"* will never have a mechanism and is exactly the nuance that makes a
 * codebase yours. A mechanism is an upgrade that moves a clause from *flagged*
 * to *proven*, never a precondition for the rule existing.
 *
 * **A mechanism is for a search, not a judgment.** Measured on `core`: zero
 * bare `except:` on prose alone, but nineteen files with `print()`, both
 * forbidden by the same `AGENTS.md`. The difference is that finding `print()`
 * across 2,571 files is a needle-in-haystack, and that is the one job where a
 * deterministic check beats a model -- not by being smarter, but by not getting
 * tired on file seven of a nine-file diff.
 *
 * Pure parsing and serialisation; the store that reads and writes files lives
 * in `main/intentStore.ts`.
 */

/** How much is actually known about a clause right now. */
export type ClauseState =
  /** A mechanism ran this session and passed. The only deterministic state. */
  | "proven"
  /** Something contradicts it -- a failing mechanism, or an agent's flag. */
  | "drifted"
  /** An agent has asked to relax it twice or more. */
  | "contested"
  /** No mechanism attached. Blocks nothing; surfaced rather than hidden. */
  | "unverifiable";

export interface Clause {
  /** Two-digit, stable across edits: it is how a clause is cited. */
  num: string;
  /** Short name, e.g. "Never served from cache". */
  name: string;
  /** The rule itself, in prose. */
  text: string;
  state: ClauseState;
  /**
   * How it is checked: a shell command run from the workspace root. Absent for
   * a prose-only clause, which is the common and expected case.
   */
  mechanism?: string;
  /** Where the clause came from, when it was seeded rather than written. */
  source?: string;
}

export interface Intent {
  id: string;
  /** One sentence: what this file or behaviour is fundamentally for. */
  headline: string;
  /**
   * Optional glob narrowing where a discriminator looks first. A hint, not a
   * boundary -- `core`'s Postgres/Elasticsearch pairing rule spans 24 files, so
   * scoping intents to one file each does not survive contact.
   */
  scope?: string;
  clauses: Clause[];
}

/**
 * Serialise to Markdown with a small YAML-ish header.
 *
 * Markdown rather than JSON because a human owns this file and will edit it by
 * hand. The format has to survive being written badly.
 */
export function toMarkdown(intent: Intent): string {
  const lines: string[] = [];
  lines.push(`# ${intent.headline}`, "");
  if (intent.scope) lines.push(`scope: ${intent.scope}`, "");

  for (const c of intent.clauses) {
    lines.push(`## ${c.num}. ${c.name}`);
    lines.push("");
    lines.push(c.text);
    lines.push("");
    if (c.mechanism) lines.push(`mechanism: \`${c.mechanism}\``, "");
    if (c.source) lines.push(`source: ${c.source}`, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Parse a `.md` intent back.
 *
 * Tolerant on purpose: this file is hand-edited, and a malformed clause should
 * cost that clause rather than the whole set. A file that parses to nothing
 * returns an intent with no clauses instead of throwing.
 */
export function fromMarkdown(id: string, source: string): Intent {
  const lines = source.split("\n");
  let headline = "";
  let scope: string | undefined;
  const clauses: Clause[] = [];

  let current: Clause | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (!current) return;
    current.text = body.join("\n").trim();
    // A clause with no prose is not a rule, whatever else it carries.
    if (current.text || current.name) clauses.push(current);
    current = null;
    body = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("# ") && !headline) {
      headline = line.slice(2).trim();
      continue;
    }

    const head = /^##\s+(\d+)\.\s*(.*)$/.exec(line);
    if (head) {
      flush();
      current = {
        num: head[1]!.padStart(2, "0"),
        name: head[2]!.trim(),
        text: "",
        // No mechanism until one is seen below; that is the honest default.
        state: "unverifiable",
      };
      continue;
    }

    const scopeMatch = /^scope:\s*(.+)$/.exec(line);
    if (scopeMatch && !current) { scope = scopeMatch[1]!.trim(); continue; }

    const mech = /^mechanism:\s*`?(.+?)`?\s*$/.exec(line);
    if (mech && current) { current.mechanism = mech[1]!.trim(); continue; }

    const src = /^source:\s*(.+)$/.exec(line);
    if (src && current) { current.source = src[1]!.trim(); continue; }

    if (current) body.push(raw);
  }
  flush();

  return { id, headline: headline || id, scope, clauses };
}

/**
 * The state a clause should show, given what the last run knew.
 *
 * Deliberately conservative. A clause with a mechanism that has not run this
 * session is **not** proven -- "it passed yesterday" and "it passes now" are
 * different claims, and the whole point of the three signal strengths is that
 * `proven` means something.
 */
export function stateOf(
  clause: Clause,
  result?: { passed: boolean; ranAt: number },
  flaggedByAgent = false,
): ClauseState {
  if (result) return result.passed ? "proven" : "drifted";
  if (flaggedByAgent) return "drifted";
  // A mechanism that has not run this session proves nothing. "It passed
  // yesterday" and "it passes now" are different claims, and `proven` only
  // means something if it means the second one.
  return "unverifiable";
}

/** Clause states in the order a reader should meet them: worst first. */
const STATE_RANK: Record<ClauseState, number> = {
  drifted: 0,
  contested: 1,
  unverifiable: 2,
  proven: 3,
};

export function sortClauses(clauses: Clause[]): Clause[] {
  return [...clauses].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    return rank !== 0 ? rank : a.num.localeCompare(b.num);
  });
}

/** How many clauses are checkable at all -- the coverage number that matters. */
export function coverage(intents: Intent[]): { total: number; withMechanism: number } {
  const all = intents.flatMap((i) => i.clauses);
  return {
    total: all.length,
    withMechanism: all.filter((c) => c.mechanism).length,
  };
}

/**
 * Rules already written in a repository's own conventions file.
 *
 * `core/AGENTS.md` is 148 lines and already contains its intents -- "no
 * print() in production code", "never bare except:", "always pair a Postgres
 * write with an Elasticsearch sync". So the first intents are not authored from
 * a blank page, they are lifted from what the team already agreed.
 *
 * Read-only: fove never writes back to a repository's own files.
 */
export function seedCandidates(markdown: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const seen = new Set<string>();

  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/^[-*]\s*/, "").trim();
    if (line.length < 12 || line.length > 200) continue;

    // Prescriptive language is what separates a rule from a description.
    if (!/\b(never|must not|do not|don't|always|must|required|no )\b/i.test(line)) continue;
    // Headings and code fences are structure, not rules.
    if (line.startsWith("#") || line.startsWith("```")) continue;

    const text = line.replace(/\*\*/g, "").trim();
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // A short name from the first clause of the sentence.
    const name = text.split(/[,.;(]/)[0]!.trim().slice(0, 60);
    out.push({ name, text });
  }

  return out;
}
