/**
 * Agent and MCP discovery, against a fixture rather than the user's real
 * ~/.claude — these read configuration that holds credentials.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let project: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-agents-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  project = await mkdtemp(join(tmpdir(), "fove-proj-"));

  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "agents", "mine.md"),
    "---\nname: mine\ndescription: my own agent\nmodel: opus\ntools: Read, Bash\n---\nYou are mine.\n");

  // A block scalar, which a naive parser reads as a bare "|".
  await writeFile(join(dir, "agents", "folded.md"),
    "---\nname: folded\ndescription: |\n  first line\n  second line\n---\nBody here.\n");

  // Malformed: must cost only itself.
  await writeFile(join(dir, "agents", "broken.md"), "not frontmatter at all\n");

  await mkdir(join(project, ".claude", "agents"), { recursive: true });
  await writeFile(join(project, ".claude", "agents", "proj.md"),
    "---\nname: proj\ndescription: project agent\n---\nProject body.\n");

  // A plugin's agents.
  const plug = join(dir, "plugins", "marketplaces", "m1", "plugins", "coolplugin", "agents");
  await mkdir(plug, { recursive: true });
  await writeFile(join(plug, "helper.md"),
    "---\nname: helper\ndescription: from a plugin\n---\nPlugin body.\n");

  await writeFile(join(project, ".mcp.json"), JSON.stringify({
    mcpServers: { localdb: { command: "db-server", args: ["--stdio"] } },
  }));
});

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe("listAgents", () => {
  test("finds user, project and plugin agents", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const names = (await listAgents(project)).map((a) => a.name);
    expect(names).toContain("mine");
    expect(names).toContain("proj");
    expect(names).toContain("helper");
  });

  test("the user's own agents come first -- those are the editable ones", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const agents = await listAgents(project);
    expect(agents[0]!.source).toBe("user");
    expect(agents.find((a) => a.name === "helper")!.source).toBe("coolplugin");
  });

  test("frontmatter fields are read, and the body is kept for preview", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const mine = (await listAgents(project)).find((a) => a.name === "mine")!;
    expect(mine.description).toBe("my own agent");
    expect(mine.model).toBe("opus");
    expect(mine.tools).toContain("Bash");
    expect(mine.body).toContain("You are mine.");
  });

  test("a block scalar description is joined, not left as a bare pipe", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const folded = (await listAgents(project)).find((a) => a.name === "folded")!;
    expect(folded.description).not.toBe("|");
    expect(folded.description).toContain("first line");
    expect(folded.description).toContain("second line");
  });

  test("a malformed file costs only itself", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const agents = await listAgents(project);
    // It still appears, named from its filename, without taking the list down.
    expect(agents.find((a) => a.name === "broken")).toBeDefined();
    expect(agents.length).toBeGreaterThanOrEqual(4);
  });

  test("no project directory is fine", async () => {
    const { listAgents } = await import("../src/data/config/agents.js");
    const agents = await listAgents();
    expect(agents.some((a) => a.name === "proj")).toBe(false);
    expect(agents.some((a) => a.name === "mine")).toBe(true);
  });
});

describe("listMcpServers", () => {
  test("reads a project's .mcp.json and classifies the transport", async () => {
    const { listMcpServers } = await import("../src/data/config/agents.js");
    const servers = await listMcpServers(project);
    const local = servers.find((s) => s.name === "localdb");
    expect(local).toBeDefined();
    expect(local!.type).toBe("stdio");
    expect(local!.scope).toBe("project");
    // A local command needs no credentials.
    expect(local!.needsAuth).toBe(false);
  });

  test("never returns a token or header value", async () => {
    const { listMcpServers } = await import("../src/data/config/agents.js");
    const servers = await listMcpServers(project);
    for (const s of servers) {
      expect(JSON.stringify(s)).not.toMatch(/authorization|bearer|sk-/i);
    }
  });
});
