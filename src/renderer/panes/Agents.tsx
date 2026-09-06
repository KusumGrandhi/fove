/**
 * Agents pane: the subagent tree and execution timeline.
 *
 * Claude Code shows subagents as a collapsed spinner and discards their
 * reasoning. This reconstructs the full tree from the transcript --
 * parent_tool_use_id plus the agent-<id>.meta.json sidecars that join the two
 * id spaces -- and lays it on a wall clock, so "four agents in parallel" can be
 * checked rather than assumed.
 */

import { useEffect, useMemo, useState } from "react";
import { C } from "../ui/Chrome.js";
import { fmtDur, fmtTokens, statusColor, useSnapshot, type AgentWire } from "../ui/widgets.js";

type View = "tree" | "timeline" | "sessions";

/**
 * A background session: a peer `claude` session in the same project folder,
 * with its own transcript. Distinct from a Task subagent (nested inside one
 * transcript) and from a teammate (its own tmux pane), and invisible to both
 * of those views because it is a sibling file rather than a nested record.
 */
interface BgSession {
  sessionId: string;
  path: string;
  name?: string;
  state: "working" | "needs-input" | "done" | "idle";
  mtimeMs: number;
  isCurrent: boolean;
}

/** Poll the project folder for peer sessions. */
function useBackgroundSessions(cwd: string, everyMs = 3000): BgSession[] {
  const [rows, setRows] = useState<BgSession[]>([]);
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = (await window.th.bgSessions(cwd)) as BgSession[];
        if (alive) setRows(r ?? []);
      } catch {
        // A folder with no sessions is normal, not an error.
      }
    };
    void tick();
    const t = setInterval(tick, everyMs);
    return () => { alive = false; clearInterval(t); };
  }, [cwd, everyMs]);
  return rows;
}

const STATE_COLOR: Record<BgSession["state"], string> = {
  "working": "#3fb950",
  "needs-input": "#d29922",
  "done": "#8b949e",
  "idle": "#6e7681",
};

export function AgentsPane(props: {
  cwd: string;
  /** Open a file in fove's own editor pane. */
  onOpen?: (path: string, line?: number) => void;
}) {
  const snap = useSnapshot(props.cwd, 2000);
  const bg = useBackgroundSessions(props.cwd);
  const [view, setView] = useState<View>("tree");
  const [selected, setSelected] = useState<string | null>(null);

  const agents = snap?.agents ?? [];
  const active = agents.find((a) => a.id === selected) ?? null;

  /** Wall-clock window spanning every agent, for the timeline. */
  const window_ = useMemo(() => {
    const starts = agents.map((a) => a.startedAt).filter((n): n is number => !!n);
    const ends = agents.map((a) => a.endedAt ?? Date.now()).filter((n): n is number => !!n);
    if (!starts.length) return null;
    const from = Math.min(...starts);
    const to = Math.max(...ends, from + 1);
    return { from, to, span: to - from };
  }, [agents]);

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <button style={tabStyle(view === "tree")} onClick={() => setView("tree")}>tree</button>
        <button style={tabStyle(view === "timeline")} onClick={() => setView("timeline")}>timeline</button>
        <button style={tabStyle(view === "sessions")} onClick={() => setView("sessions")}>
          sessions
          {bg.filter((b) => b.state === "working" || b.state === "needs-input").length > 0 && (
            <span style={S.badge}>
              {bg.filter((b) => b.state === "working" || b.state === "needs-input").length}
            </span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        <span style={S.meta}>
          {agents.length} agents
          {snap && ` · ${snap.parsed} lines in ${snap.elapsedMs}ms`}
        </span>
      </div>

      {view === "sessions" ? (
        bg.length === 0 ? (
          <div style={S.empty}>no claude sessions in this folder</div>
        ) : (
          <div style={S.list}>
            {bg.map((b) => (
              <div
                key={b.sessionId}
                style={{ ...S.row, opacity: b.state === "idle" ? 0.55 : 1 }}
                title={`${b.path}\nclick to open the transcript`}
                onClick={() => props.onOpen?.(b.path)}
              >
                <span style={{ color: STATE_COLOR[b.state] }}>●</span>
                <span style={{ color: C.fg, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {b.name ?? b.sessionId.slice(0, 8)}
                </span>
                {b.isCurrent && <span style={S.here}>this pane</span>}
                <span style={{ color: C.faint }}>{b.state}</span>
              </div>
            ))}
          </div>
        )
      ) : agents.length === 0 ? (
        <div style={S.empty}>
          {snap ? "no subagents in this session" : "no claude session in this folder"}
        </div>
      ) : (
        <div style={S.body}>
          <div style={S.list}>
            {view === "tree"
              ? agents.map((a) => (
                  <Row key={a.id} a={a} selected={a.id === selected} onClick={() => setSelected(a.id)} />
                ))
              : agents.map((a) => (
                  <Lane
                    key={a.id}
                    a={a}
                    win={window_}
                    selected={a.id === selected}
                    onClick={() => setSelected(a.id)}
                  />
                ))}
          </div>

          {active && (
            <div style={S.detail}>
              <div style={S.detailHead}>
                <span style={{ color: statusColor(active.status) }}>●</span>
                <span style={{ color: C.fg }}>{active.label ?? active.name}</span>
              </div>
              <Meta label="agent" value={active.name} />
              <Meta label="model" value={(active.model ?? "—").replace("claude-", "")} />
              <Meta label="status" value={active.status} />
              <Meta
                label="elapsed"
                value={active.startedAt && active.endedAt ? fmtDur(active.endedAt - active.startedAt) : "—"}
              />
              <Meta label="tokens" value={fmtTokens(active.tokens)} />
              <Meta label="tool calls" value={String(active.toolCalls)} />
              {active.files.length > 0 && (
                <>
                  <div style={S.detailLabel}>files touched</div>
                  {active.files.slice(0, 8).map((f) => (
                    <div
                      key={f}
                      style={S.fileRow}
                      title={`${f} — click to open in the editor`}
                      onClick={() => props.onOpen?.(f)}
                    >
                      {f.split("/").slice(-2).join("/")}
                    </div>
                  ))}
                </>
              )}
              {active.lastText && (
                <>
                  <div style={S.detailLabel}>last output</div>
                  <div style={S.excerpt}>{active.lastText}</div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row(props: { a: AgentWire; selected: boolean; onClick: () => void }) {
  const { a } = props;
  return (
    <div
      onClick={props.onClick}
      style={{
        ...S.row,
        paddingLeft: 8 + Math.max(0, a.depth - 1) * 12,
        background: props.selected ? "#1e2636" : undefined,
      }}
    >
      <span style={{ color: statusColor(a.status), width: 12 }}>
        {a.status === "running" ? "◉" : a.status === "error" ? "✖" : "●"}
      </span>
      <span style={{ ...S.name, color: props.selected ? C.fg : C.dim }}>
        {a.label ?? a.name}
      </span>
      <span style={S.col}>{(a.model ?? "").replace("claude-", "")}</span>
      <span style={S.colNum}>
        {a.startedAt && a.endedAt ? fmtDur(a.endedAt - a.startedAt) : "—"}
      </span>
      <span style={S.colNum}>{fmtTokens(a.tokens)}</span>
    </div>
  );
}

/** One swimlane: the bar spans exactly when the agent ran. */
function Lane(props: {
  a: AgentWire;
  win: { from: number; to: number; span: number } | null;
  selected: boolean;
  onClick: () => void;
}) {
  const { a, win } = props;
  const start = a.startedAt ?? win?.from ?? 0;
  const end = a.endedAt ?? win?.to ?? 1;
  const left = win ? ((start - win.from) / win.span) * 100 : 0;
  const width = win ? Math.max(0.8, ((end - start) / win.span) * 100) : 100;

  return (
    <div
      onClick={props.onClick}
      style={{ ...S.row, background: props.selected ? "#1e2636" : undefined }}
    >
      <span style={{ ...S.laneName, color: props.selected ? C.fg : C.dim }}>
        {a.label ?? a.name}
      </span>
      <div style={S.laneTrack}>
        <div
          style={{
            ...S.laneBar,
            left: `${left}%`,
            width: `${width}%`,
            background: statusColor(a.status),
          }}
        />
      </div>
      <span style={S.colNum}>
        {a.startedAt && a.endedAt ? fmtDur(a.endedAt - a.startedAt) : "—"}
      </span>
    </div>
  );
}

function Meta(props: { label: string; value: string }) {
  return (
    <div style={S.metaRow}>
      <span style={{ color: C.faint }}>{props.label}</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: C.dim }}>{props.value}</span>
    </div>
  );
}

const tabStyle = (on: boolean): React.CSSProperties => ({
  background: on ? "#1e2636" : "transparent",
  border: `1px solid ${on ? C.line : "transparent"}`,
  color: on ? C.fg : C.faint,
  borderRadius: 4, padding: "1px 9px", cursor: "pointer", fontSize: 11,
});

const S: Record<string, React.CSSProperties> = {
  badge: { marginLeft: 5, padding: "0 5px", borderRadius: 8, background: "#3fb950",
           color: "#0d0d11", fontSize: 10, fontWeight: 600 },
  here: { padding: "0 5px", borderRadius: 3, background: "#1c2333",
          color: "#58a6ff", fontSize: 10 },
  pane: { display: "flex", flexDirection: "column", height: "100%", background: "#0d0d11",
          color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden" },
  bar: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
         background: "#14141a", borderBottom: `1px solid ${C.line}`, flexShrink: 0 },
  meta: { color: C.faint, fontSize: 10 },
  body: { display: "flex", flex: 1, minHeight: 0 },
  list: { flex: 1, minWidth: 0, overflowY: "auto", padding: "3px 0" },
  row: { display: "flex", gap: 6, alignItems: "center", padding: "2px 8px",
         cursor: "pointer", lineHeight: "19px" },
  name: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  col: { color: C.faint, fontSize: 10, width: 62, textAlign: "right" },
  colNum: { color: C.faint, fontSize: 10, width: 54, textAlign: "right",
            fontVariantNumeric: "tabular-nums" },
  laneName: { width: 150, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", fontSize: 11 },
  laneTrack: { flex: 1, minWidth: 0, height: 11, background: "#15151c", borderRadius: 3,
               position: "relative" },
  laneBar: { position: "absolute", top: 0, height: "100%", borderRadius: 3, opacity: 0.85 },
  detail: { width: 210, flexShrink: 0, borderLeft: `1px solid ${C.line}`, padding: "7px 9px",
            overflowY: "auto", background: "#0f0f14" },
  detailHead: { display: "flex", gap: 6, alignItems: "center", marginBottom: 7, fontSize: 12 },
  detailLabel: { color: C.faint, fontSize: 10, marginTop: 9, marginBottom: 3,
                 letterSpacing: 0.5 },
  metaRow: { display: "flex", fontSize: 11, lineHeight: "18px" },
  fileRow: { color: C.dim, fontSize: 10, lineHeight: "16px", cursor: "pointer",
             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  excerpt: { color: C.faint, fontSize: 10, lineHeight: "14px",
             maxHeight: 90, overflow: "hidden" },
  empty: { padding: 14, color: "#33333c", fontSize: 11 },
};
