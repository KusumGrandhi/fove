/**
 * Agent definitions and MCP servers — the two pieces of configuration that
 * decide what Claude can do, neither of which the CLI shows you in one place.
 *
 * An agent is a markdown file with YAML frontmatter (`name`, `description`,
 * `model`, `tools`, …) and a body that is its system prompt. They live in
 * several places at once — the user's own directory, the project's, and inside
 * every installed plugin — which is exactly why a single browsable list is
 * worth having.
 *
 * The frontmatter parser here is deliberately small: it reads the flat
 * `key: value` pairs these files actually use rather than pulling in a YAML
 * dependency, and skips anything it does not recognise instead of throwing. A
 * malformed agent file should cost you that one agent, not the whole list.
 *
 * **`~/.claude.json` is read, never written.** It holds live credentials
 * alongside server definitions, and round-tripping it risks dropping keys and
 * rewriting secrets to disk.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools?: string;
  color?: string;
  /** Where it came from: "user", "project", or a plugin name. */
  source: string;
  path: string;
  /** The system prompt body, for preview. */
  body: string;
}

export interface McpServer {
  name: string;
  /** "stdio", "sse", "http" — as recorded in the config. */
  type: string;
  /** Command or URL, whichever the transport uses. */
  target: string;
  /** True when the entry needs credentials fove cannot supply. */
  needsAuth: boolean;
  scope: "user" | "project";
}

/**
 * Parse the frontmatter block of an agent file.
 *
 * Values may be quoted or bare; a colon inside a value (common in a
 * description) must not split the pair, so only the first one separates.
 */
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: text };

  const block = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n+/, "");
  const fields: Record<string, string> = {};

  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = line.indexOf(":");
    // Skip blanks, comments and continuation lines of a folded value.
    if (at <= 0 || line.startsWith("#") || line.startsWith(" ")) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();

    // A block scalar (`description: |` or `>`) puts the text on the indented
    // lines that follow. Without this the value reads as a bare "|".
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const collected: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1] ?? "")) {
        collected.push((lines[++i] ?? "").trim());
      }
      value = collected.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (
      (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { fields, body };
}

async function readAgentDir(dir: string, source: string): Promise<AgentDef[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // a directory that does not exist is not an error
  }
  const out: AgentDef[] = [];
  for (const file of names) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      const text = await readFile(path, "utf8");
      const { fields, body } = frontmatter(text);
      const name = fields.name || file.replace(/\.md$/, "");
      out.push({
        name,
        description: fields.description ?? "",
        model: fields.model,
        tools: fields.tools,
        color: fields.color,
        source,
        path,
        body: body.slice(0, 4000),
      });
    } catch {
      continue; // one unreadable file must not lose the rest
    }
  }
  return out;
}

/**
 * Every agent fove can see: the user's, the project's, and each plugin's.
 *
 * Sorted by source then name so the user's own agents lead — those are the
 * ones they can actually edit.
 */
export async function listAgents(projectDir?: string): Promise<AgentDef[]> {
  const found: AgentDef[] = [];

  found.push(...(await readAgentDir(join(CLAUDE_DIR, "agents"), "user")));
  if (projectDir) {
    found.push(...(await readAgentDir(join(projectDir, ".claude", "agents"), "project")));
  }

  // Plugins keep their agents inside each marketplace checkout.
  const marketplaces = join(CLAUDE_DIR, "plugins", "marketplaces");
  try {
    for (const market of await readdir(marketplaces)) {
      const plugins = join(marketplaces, market, "plugins");
      let entries: string[];
      try {
        entries = await readdir(plugins);
      } catch {
        continue;
      }
      for (const plugin of entries) {
        const dir = join(plugins, plugin, "agents");
        try {
          if (!(await stat(dir)).isDirectory()) continue;
        } catch {
          continue;
        }
        found.push(...(await readAgentDir(dir, plugin)));
      }
    }
  } catch {
    // No plugins installed.
  }

  const rank = (s: string) => (s === "user" ? 0 : s === "project" ? 1 : 2);
  return found.sort(
    (a, b) => rank(a.source) - rank(b.source) || a.name.localeCompare(b.name),
  );
}

/**
 * MCP servers from `~/.claude.json` and the project's `.mcp.json`.
 *
 * Read-only, deliberately: see the file header. Nothing here returns a token
 * or header value, only whether one is required.
 */
export async function listMcpServers(projectDir?: string): Promise<McpServer[]> {
  const out: McpServer[] = [];

  const collect = (raw: unknown, scope: "user" | "project") => {
    const servers = (raw as { mcpServers?: Record<string, unknown> })?.mcpServers;
    if (!servers || typeof servers !== "object") return;
    for (const [name, cfgRaw] of Object.entries(servers)) {
      const cfg = cfgRaw as Record<string, unknown>;
      const type = String(cfg.type ?? (cfg.command ? "stdio" : "http"));
      const target = String(cfg.url ?? cfg.command ?? "");
      // A server carrying headers or an env block generally wants credentials.
      const needsAuth =
        !!cfg.headers ||
        (!!cfg.env && Object.keys(cfg.env as object).length > 0) ||
        /^https?:/.test(target);
      out.push({ name, type, target, needsAuth, scope });
    }
  };

  try {
    collect(JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")), "user");
  } catch {
    // Absent or unreadable: nothing to list.
  }
  if (projectDir) {
    try {
      collect(JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8")), "project");
    } catch {
      // Most projects have none.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
