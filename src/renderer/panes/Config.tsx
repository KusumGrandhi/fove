/**
 * The configuration that shapes what Claude can do: agent definitions, MCP
 * servers, and skills — in one browsable place.
 *
 * The CLI can list each of these, but never together, and never with the one
 * fact that matters when deciding what to keep: what each costs you in system
 * prompt tokens every session.
 *
 * Read-only by design for MCP. `~/.claude.json` holds live credentials, and
 * this pane shows only whether a server *needs* auth, never a token itself.
 */

import { useCallback, useEffect, useState } from "react";
import { C } from "../ui/Chrome.js";

interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools?: string;
  source: string;
  path: string;
  body: string;
}

interface McpServer {
  name: string;
  type: string;
  target: string;
  needsAuth: boolean;
  scope: "user" | "project";
}

interface SkillInfo {
  name: string;
  path: string;
  /** Resolved target when SKILL.md is a symlink (e.g. a gstack bundle). */
  linkTarget?: string;
  bundle?: string;
  description?: string;
  frontmatterBytes: number;
  usageCount: number;
  lastUsedAt?: number;
  override?: "on" | "off" | "name-only" | "user-invocable-only";
}

type View = "agents" | "mcp" | "skills";

export function ConfigPane(props: {
  cwd: string;
  /** Open a file in fove's own editor pane. */
  onOpen?: (path: string, line?: number) => void;
}) {
  const [view, setView] = useState<View>("agents");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [budget, setBudget] = useState<{ tokens: number; enabled: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The selected skill, kept apart from the agent selection.
   *
   * Agents and skills are separate namespaces, so one shared key would let a
   * skill and an agent of the same name select each other when the tab changes.
   */
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const [a, m, sk] = await Promise.all([
      window.th.agentsList(props.cwd) as Promise<AgentDef[]>,
      window.th.mcpList(props.cwd) as Promise<McpServer[]>,
      window.th.skillsList() as Promise<{
        skills: SkillInfo[];
        budget: { tokens: number; enabled: number };
      }>,
    ]);
    setAgents(a ?? []);
    setServers(m ?? []);
    setSkills(sk?.skills ?? []);
    setBudget(sk?.budget ?? null);
  }, [props.cwd]);

  /**
   * Cycle a skill: on -> name -> /only -> off.
   *
   * The two middle states are the useful ones. "name" keeps the skill
   * model-reachable for a fraction of the cost -- worth it where the name
   * alone says what the skill does. "/only" keeps it typeable as /name but
   * hides it from Claude entirely. Writes to ~/.claude/settings.json, never
   * ~/.claude.json.
   */
  const toggleSkill = useCallback(async (sk: SkillInfo) => {
    await window.th.skillsToggle(sk.name, sk.override);
    await load();
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.source.toLowerCase().includes(q),
      )
    : agents;
  const active = agents.find((a) => a.name === selected) ?? null;

  // Skills filter on the same terms as agents: name, description, bundle.
  const shownSkills = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q) ||
          (s.bundle ?? "").toLowerCase().includes(q),
      )
    : skills;
  const activeSkill = skills.find((s) => s.name === selectedSkill) ?? null;

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <button style={tab(view === "agents")} onClick={() => setView("agents")}>
          agents {agents.length > 0 ? agents.length : ""}
        </button>
        <button style={tab(view === "mcp")} onClick={() => setView("mcp")}>
          mcp {servers.length > 0 ? servers.length : ""}
        </button>
        <button style={tab(view === "skills")} onClick={() => setView("skills")}>
          skills {skills.length > 0 ? skills.length : ""}
        </button>
        <div style={{ flex: 1 }} />
        {(view === "agents" || view === "skills") && (
          <input
            style={S.search}
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // The app's own shortcuts must not fire while typing here.
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        <button style={S.ghost} onClick={() => void load()}>refresh</button>
      </div>

      {view === "agents" ? (
        <div style={S.body}>
          <div style={S.list}>
            {shown.length === 0 ? (
              <div style={S.empty}>{agents.length === 0 ? "no agents found" : "nothing matches"}</div>
            ) : (
              shown.map((a) => (
                <div
                  key={`${a.source}/${a.name}`}
                  style={{ ...S.row, ...(a.name === selected ? S.rowActive : null) }}
                  onClick={() => setSelected(a.name)}
                  title={a.path}
                >
                  <span style={sourceStyle(a.source)}>{a.source}</span>
                  <span style={S.name}>{a.name}</span>
                  <span style={S.desc}>{a.description}</span>
                </div>
              ))
            )}
          </div>

          {active && (
            <div style={S.detail}>
              <div style={S.detailHead}>{active.name}</div>
              <Meta label="source" value={active.source} />
              <Meta label="model" value={active.model ?? "inherit"} />
              {active.tools && <Meta label="tools" value={active.tools} />}
              <div style={S.detailLabel}>description</div>
              <div style={S.excerpt}>{active.description || "—"}</div>
              <div style={S.detailLabel}>system prompt</div>
              <div style={S.excerpt}>{active.body.slice(0, 900) || "—"}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  style={S.ghost}
                  onClick={() => props.onOpen?.(active.path)}
                  disabled={!props.onOpen}
                >
                  open definition
                </button>
                {/* The escape hatch stays, but is no longer the default. */}
                <button
                  style={S.ghost}
                  title="Open in VS Code"
                  onClick={() => window.th.openInEditor(active.path)}
                >
                  ↗
                </button>
              </div>
            </div>
          )}
        </div>
      ) : view === "skills" ? (
        /*
         * Master-detail, the same shape as the agents view.
         *
         * The row used to carry everything -- state, name, description, cost,
         * usage and two buttons -- because there was nowhere else to put it,
         * and at a narrow pane width the buttons clipped. Reading a skill now
         * happens in the detail panel, so the row is back to three things and
         * "open" lives where it does for an agent definition.
         */
        <div style={S.body}>
          <div style={S.list}>
            {budget && (
              <div style={S.budget}>
                <b style={{ color: C.fg }}>~{Math.round(budget.tokens / 100) / 10}k tokens</b>
                {" "}of descriptions load every session · {budget.enabled} enabled
                {skills.filter((k) => k.usageCount === 0).length > 0 && (
                  <> · <span style={{ color: "#d29922" }}>
                    {skills.filter((k) => k.usageCount === 0).length} never used
                  </span></>
                )}
              </div>
            )}
            {shownSkills.length === 0 ? (
              <div style={S.empty}>
                {skills.length === 0 ? "no skills found" : "nothing matches"}
              </div>
            ) : (
              shownSkills.map((k) => {
                const state = k.override ?? "on";
                return (
                  <div
                    key={k.name}
                    style={{ ...S.row, ...(k.name === selectedSkill ? S.rowActive : null) }}
                    onClick={() => setSelectedSkill(k.name)}
                    title={k.path}
                  >
                    {/*
                     * The state badge stays in the row and stops the click from
                     * reaching it: toggling cost is the one action worth doing
                     * without selecting first, and selecting on toggle would
                     * swap the detail panel out from under the click.
                     */}
                    <button
                      style={{ ...S.state, ...stateStyle(state) }}
                      onClick={(e) => { e.stopPropagation(); void toggleSkill(k); }}
                      title="on -> name -> /only -> off"
                    >
                      {stateLabel(state)}
                    </button>
                    <span style={S.name}>{k.name}</span>
                    <span style={S.desc}>{k.description ?? ""}</span>
                  </div>
                );
              })
            )}
            {/* Inside the scrolling list, not beside it: S.body is a flex row,
                so a sibling here would become a third column. */}
            <div style={S.note}>
              Sorted by cost per use. Click a skill to read it; <b>open definition</b>
              {" "}shows its <code>SKILL.md</code> in the editor pane.
              <b> name</b> sends the skill's name without its description — Claude
              can still choose it, for a fraction of the tokens, which suits a skill
              whose name says what it does. <b>/only</b> hides it from Claude
              entirely but keeps it typeable as <code>/name</code>. <b>off</b> hides
              it from both. Toggles are written to
              <code> ~/.claude/settings.json</code>, are reversible, and survive
              upgrades.
            </div>
          </div>

          {activeSkill && (
            <div style={S.detail}>
              <div style={S.detailHead}>{activeSkill.name}</div>
              <Meta label="state" value={stateLabel(activeSkill.override ?? "on")} />
              {activeSkill.bundle && <Meta label="bundle" value={activeSkill.bundle} />}
              <Meta label="standing cost" value={`${standingTokens(activeSkill)} tokens`} />
              <Meta
                label="used"
                value={activeSkill.usageCount > 0 ? `${activeSkill.usageCount}×` : "never"}
              />
              {/* Only meaningful once it has been used, and misleading at 0. */}
              {activeSkill.lastUsedAt && (
                <Meta
                  label="last used"
                  value={new Date(activeSkill.lastUsedAt).toLocaleDateString()}
                />
              )}
              <div style={S.detailLabel}>description</div>
              <div style={S.excerpt}>{activeSkill.description || "—"}</div>
              <div style={S.detailLabel}>path</div>
              <div style={S.excerpt}>{activeSkill.path}</div>
              {/* A gstack bundle reaches SKILL.md through a symlink, and the
                  target is where an edit actually lands. Shown as a block
                  rather than a Meta row: a path has nothing to wrap at, and
                  Meta's right-aligned single line just clips it. */}
              {activeSkill.linkTarget && (
                <>
                  <div style={S.detailLabel}>links to</div>
                  <div style={S.excerpt}>{activeSkill.linkTarget}</div>
                </>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  style={S.ghost}
                  onClick={() => props.onOpen?.(activeSkill.path)}
                  disabled={!props.onOpen}
                >
                  open definition
                </button>
                {/* The escape hatch stays, but is no longer the default. */}
                <button
                  style={S.ghost}
                  title="Open in VS Code"
                  onClick={() => window.th.openInEditor(activeSkill.path)}
                >
                  ↗
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={S.list}>
          {servers.length === 0 ? (
            <div style={S.empty}>no MCP servers configured</div>
          ) : (
            servers.map((s) => (
              <div key={`${s.scope}/${s.name}`} style={S.row}>
                <span style={sourceStyle(s.scope)}>{s.scope}</span>
                <span style={S.name}>{s.name}</span>
                <span style={S.tag}>{s.type}</span>
                <span style={S.desc}>{s.target}</span>
                {s.needsAuth && <span style={S.auth}>auth</span>}
              </div>
            ))
          )}
          <div style={S.note}>
            Read-only. Servers are defined in <code>~/.claude.json</code>, which holds
            live credentials — fove never writes it. Add or authorise servers with{" "}
            <code>claude mcp</code> or <code>/mcp</code>.
          </div>
        </div>
      )}
    </div>
  );
}

function Meta(props: { label: string; value: string }) {
  return (
    <div style={S.meta}>
      <span style={{ color: C.faint }}>{props.label}</span>
      <span style={{ color: C.fg, textAlign: "right", flex: 1 }}>{props.value}</span>
    </div>
  );
}

const tab = (on: boolean): React.CSSProperties => ({
  padding: "2px 9px",
  borderRadius: 4,
  border: `1px solid ${on ? C.accent : "transparent"}`,
  background: on ? "#1a2233" : "transparent",
  color: on ? C.fg : C.faint,
  fontSize: 11,
  cursor: "pointer",
});

const sourceStyle = (source: string): React.CSSProperties => ({
  padding: "0 5px",
  borderRadius: 3,
  fontSize: 10,
  flex: "0 0 auto",
  // The user's own definitions are the ones they can change; plugins are not.
  background: source === "user" || source === "project" ? "#12261a" : "#1c1c26",
  color: source === "user" || source === "project" ? "#3fb950" : "#8b949e",
});

/**
 * Four states, four labels. "name" is short for name-only: Claude sees the
 * skill's name but not its description.
 */
const stateLabel = (state: string): string =>
  state === "on" ? "on" : state === "off" ? "off" : state === "name-only" ? "name" : "/only";

/**
 * Colour tracks cost, not alphabetical order: green is fully on, red is fully
 * off, and the two middle states share the amber family -- name-only brighter
 * than /only, because it is the one Claude can still reach.
 */
const stateStyle = (state: string): React.CSSProperties =>
  state === "on"
    ? { background: "#12261a", color: "#3fb950", borderColor: "#1d4429" }
    : state === "off"
      ? { background: "#2a1214", color: "#f85149", borderColor: "#6e2b30" }
      : state === "name-only"
        ? { background: "#1d2733", color: "#58a6ff", borderColor: "#24384f" }
        : { background: "#2a2418", color: "#d29922", borderColor: "#3d3527" };

/**
 * What this skill actually costs per session, in tokens.
 *
 * Mirrors `standingBytes` in data/config/skills.ts: a name-only skill sends
 * its name, not its description, and showing it the full frontmatter cost
 * would contradict the budget line directly above the list.
 */
const standingTokens = (k: SkillInfo): number => {
  const state = k.override ?? "on";
  if (state === "off" || state === "user-invocable-only") return 0;
  if (state === "name-only") return Math.round((k.name.length + 2) / 4);
  return Math.round(k.frontmatterBytes / 4);
};

const S: Record<string, React.CSSProperties> = {
  budget: {
    padding: "7px 9px", margin: "6px 8px", borderRadius: 5,
    background: "#12121a", border: "1px solid #23232c",
    color: C.faint, fontSize: 11, lineHeight: 1.5,
  },
  state: {
    minWidth: 44, padding: "1px 6px", borderRadius: 3, border: "1px solid",
    fontSize: 10, cursor: "pointer", flex: "0 0 auto",
  },
  pane: {
    display: "flex", flexDirection: "column", height: "100%", background: "#0d0d11",
    color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden",
  },
  bar: {
    display: "flex", alignItems: "center", gap: 4, padding: "5px 8px",
    background: "#12121a", borderBottom: "1px solid #23232c",
  },
  search: {
    background: "#0d0d11", border: "1px solid #2a2a34", borderRadius: 4,
    color: C.fg, fontSize: 11, padding: "2px 7px", width: 130, outline: "none",
  },
  ghost: {
    padding: "2px 9px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
  },
  body: { display: "flex", flex: 1, minHeight: 0 },
  list: { flex: 1, overflow: "auto", minHeight: 0 },
  row: {
    display: "flex", alignItems: "center", gap: 7, padding: "3px 8px",
    fontSize: 11, cursor: "pointer",
  },
  rowActive: { background: "#161c28" },
  name: { color: C.fg, flex: "0 0 auto" },
  nameOpen: { cursor: "pointer", textDecoration: "underline", textDecorationColor: "#33333d" },
  desc: {
    color: C.faint, flex: 1, overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  tag: { padding: "0 5px", borderRadius: 3, background: "#1c2333", color: "#58a6ff", fontSize: 10 },
  auth: { padding: "0 5px", borderRadius: 3, background: "#2a2418", color: "#d29922", fontSize: 10 },
  detail: {
    width: 300, flex: "0 0 300px", borderLeft: "1px solid #23232c",
    padding: "8px 10px", overflow: "auto", display: "flex", flexDirection: "column", gap: 4,
  },
  detailHead: { color: C.fg, fontSize: 13, marginBottom: 4 },
  detailLabel: { color: C.faint, fontSize: 10, marginTop: 8, textTransform: "uppercase" },
  meta: { display: "flex", gap: 8, fontSize: 11 },
  excerpt: {
    background: "#12121a", border: "1px solid #23232c", borderRadius: 4,
    padding: "6px 8px", color: "#c9c9d1", fontSize: 11, lineHeight: 1.5,
    whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto",
    // A path has no spaces to wrap at, so pre-wrap alone overflows the panel
    // and hands it a horizontal scrollbar. Break anywhere instead.
    overflowWrap: "anywhere",
  },
  empty: { padding: 12, color: C.faint, fontSize: 11 },
  note: { padding: "10px 12px", color: C.faint, fontSize: 10, lineHeight: 1.6 },
};
