import { expect, test, describe } from "vitest";
import { AgentTree, ROOT_ID } from "../src/data/agentTree.js";
import { parseLine } from "../src/data/transcript.js";

const rec = (o: Record<string, unknown>) => o as any;

describe("parseLine", () => {
  test("skips blank and malformed lines instead of throwing", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("{not json")).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();       // arrays are not records
    expect(parseLine('"str"')).toBeNull();
    expect(parseLine('{"type":"user"}')).toEqual({ type: "user" } as any);
  });
});

describe("AgentTree", () => {
  test("ignores unknown record types without throwing", () => {
    const t = new AgentTree();
    for (const ty of ["queue-operation", "ai-title", "file-history-snapshot", "???"]) {
      t.addRecord(rec({ type: ty }));
    }
    expect(t.nodes.size).toBe(1); // root only
    expect(t.orphans()).toHaveLength(0);
  });

  test("an Agent tool_use creates a child keyed by the tool_use id", () => {
    const t = new AgentTree();
    t.addRecord(rec({
      type: "assistant", uuid: "u1", timestamp: "2026-01-01T00:00:00Z",
      message: { content: [{ type: "tool_use", id: "toolu_A", name: "Agent",
        input: { subagent_type: "Explore", description: "find X" } }] },
    }));
    const child = t.nodes.get("toolu_A");
    expect(child).toBeDefined();
    expect(child!.name).toBe("Explore");
    expect(child!.label).toBe("find X");
    expect(child!.parentId).toBe(ROOT_ID);
    expect(child!.depth).toBe(1);
  });

  test("registerMeta merges the agentId and tool_use id spaces into one node", () => {
    const t = new AgentTree();
    // Sidecar links hex agentId -> spawning tool_use id.
    t.registerMeta([{ agentId: "abc123", agentType: "general-purpose",
                      description: "batch 07", toolUseId: "toolu_A", spawnDepth: 1 }]);
    // Main transcript spawns it by tool_use id.
    t.addRecord(rec({ type: "assistant", uuid: "u1", timestamp: "2026-01-01T00:00:00Z",
      message: { content: [{ type: "tool_use", id: "toolu_A", name: "Agent",
        input: { subagent_type: "general-purpose" } }] } }));
    // Subagent log reports usage under the hex agentId.
    t.addRecord(rec({ type: "assistant", agentId: "abc123", isSidechain: true,
      uuid: "u2", timestamp: "2026-01-01T00:00:05Z",
      message: { id: "m1", model: "claude-fable-5",
        usage: { input_tokens: 2, cache_creation_input_tokens: 25818 },
        content: [{ type: "text", text: "working" }] } }));

    // One node, not two.
    expect(t.nodes.size).toBe(2); // root + the single merged agent
    const n = t.nodes.get("toolu_A")!;
    expect(n.name).toBe("general-purpose");
    expect(n.label).toBe("batch 07");
    expect(n.model).toBe("claude-fable-5");
    expect(n.usage.cache_creation_input_tokens).toBe(25818);
    expect(t.orphans()).toHaveLength(0);
  });

  test("deduplicates usage across parallel tool calls sharing a message id", () => {
    const t = new AgentTree();
    const mk = () => rec({ type: "assistant", uuid: crypto.randomUUID(),
      message: { id: "same-id", usage: { input_tokens: 100 }, content: [] } });
    t.addRecord(mk());
    t.addRecord(mk());
    t.addRecord(mk());
    expect(t.root.usage.input_tokens).toBe(100); // counted once, not 300
  });

  test("tool_result closes the child agent and records error state", () => {
    const t = new AgentTree();
    t.addRecord(rec({ type: "assistant", uuid: "u1",
      message: { content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: {} }] } }));
    expect(t.nodes.get("toolu_A")!.status).toBe("queued");
    t.addRecord(rec({ type: "user", uuid: "u2", timestamp: "2026-01-01T00:01:00Z",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_A", is_error: true }] } }));
    expect(t.nodes.get("toolu_A")!.status).toBe("error");
  });

  test("nested fan-out attaches at the correct depth", () => {
    const t = new AgentTree();
    t.addRecord(rec({ type: "assistant", uuid: "u1",
      message: { content: [{ type: "tool_use", id: "toolu_A", name: "Agent",
        input: { subagent_type: "parent" } }] } }));
    // The child agent itself spawns one, marked via parent_tool_use_id.
    t.addRecord(rec({ type: "assistant", uuid: "u2", parent_tool_use_id: "toolu_A",
      message: { content: [{ type: "tool_use", id: "toolu_B", name: "Agent",
        input: { subagent_type: "grandchild" } }] } }));
    const gc = t.nodes.get("toolu_B")!;
    expect(gc.parentId).toBe("toolu_A");
    expect(gc.depth).toBe(2);
    expect(t.orphans()).toHaveLength(0);
    expect(t.ordered().map((n) => n.id)).toEqual([ROOT_ID, "toolu_A", "toolu_B"]);
  });

  test("flags files written by more than one agent", () => {
    const t = new AgentTree();
    const write = (agent: string, path: string) => rec({
      type: "assistant", uuid: crypto.randomUUID(), parent_tool_use_id: agent,
      message: { content: [{ type: "tool_use", id: crypto.randomUUID(), name: "Edit",
        input: { file_path: path } }] } });
    t.registerMeta([
      { agentId: "x", toolUseId: "toolu_A", agentType: "a" },
      { agentId: "y", toolUseId: "toolu_B", agentType: "b" },
    ]);
    t.addRecord(write("toolu_A", "/repo/shared.js"));
    t.addRecord(write("toolu_B", "/repo/shared.js"));
    t.addRecord(write("toolu_A", "/repo/only-a.js"));
    const col = t.fileCollisions();
    expect([...col.keys()]).toEqual(["/repo/shared.js"]);
    expect(col.get("/repo/shared.js")).toHaveLength(2);
  });
});
