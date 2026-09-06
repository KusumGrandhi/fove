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

type View = "agents" | "mcp";

export function ConfigPane(props: { cwd: string }) {
  const [view, setView] = useState<View>("agents");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const [a, m] = await Promise.all([
      window.th.agentsList(props.cwd) as Promise<AgentDef[]>,
      window.th.mcpList(props.cwd) as Promise<McpServer[]>,
    ]);
    setAgents(a ?? []);
    setServers(m ?? []);
  }, [props.cwd]);

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

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <button style={tab(view === "agents")} onClick={() => setView("agents")}>
          agents {agents.length > 0 ? agents.length : ""}
        </button>
        <button style={tab(view === "mcp")} onClick={() => setView("mcp")}>
          mcp {servers.length > 0 ? servers.length : ""}
        </button>
        <div style={{ flex: 1 }} />
        {view === "agents" && (
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
              <button style={S.ghost} onClick={() => window.th.openInEditor(active.path)}>
                open definition ↗
              </button>
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

const S: Record<string, React.CSSProperties> = {
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
  },
  empty: { padding: 12, color: C.faint, fontSize: 11 },
  note: { padding: "10px 12px", color: C.faint, fontSize: 10, lineHeight: 1.6 },
};
