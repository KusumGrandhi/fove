/**
 * Stats-rail widgets: what the agent is doing, and what it is costing.
 *
 * Everything here reads the transcript Claude Code already writes, so nothing
 * needs instrumenting. Numbers come from modelUsage rather than usage --
 * usage excludes subagent tokens entirely, which for an app built around
 * subagents would make every figure quietly wrong.
 */

import { useEffect, useState, type ReactNode } from "react";
import { C } from "./Chrome.js";

export interface AgentWire {
  id: string; parentId: string | null; name: string; label?: string;
  model?: string; status: string; startedAt?: number; endedAt?: number;
  depth: number; tokens: number; toolCalls: number; files: string[]; lastText?: string;
}

export interface Snapshot {
  sessionId: string;
  agents: AgentWire[];
  totals: {
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number;
    costUSD: number; wholeTree: boolean;
  };
  models: string[];
  firstPrompt?: string;
  parsed: number;
  elapsedMs: number;
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
};

export const statusColor = (s: string): string =>
  s === "running" ? "#d29922" : s === "error" ? "#e5534b" : s === "done" ? "#3fb950" : C.faint;

/** Poll the newest Claude session for a directory. */
/**
 * Watch a Claude session.
 *
 * `paneId` identifies the pane whose session to follow. Without it the newest
 * transcript in the directory is used, which is only correct when a single
 * session is open -- with an editor and a fove pane both running, that is
 * whichever was typed in last.
 */
export function useSnapshot(
  cwd: string,
  intervalMs = 2500,
  paneId?: string,
): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = (await window.th.claudeSnapshot(cwd, paneId)) as Snapshot | null;
      if (alive) setSnap(s);
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [cwd, intervalMs, paneId]);
  return snap;
}

export function Widget(props: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section style={W.card}>
      <header style={W.head}>
        <span>{props.title}</span>
        <div style={{ flex: 1 }} />
        {props.right}
      </header>
      <div style={W.body}>{props.children}</div>
    </section>
  );
}

/** Token totals and cache efficiency for the current session. */
export function TokensWidget(props: { snap: Snapshot | null }) {
  const t = props.snap?.totals;
  const total = t ? t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens : 0;
  const cacheDenom = t ? t.cacheReadTokens + t.inputTokens + t.cacheCreationTokens : 0;
  const hit = cacheDenom ? Math.round((t!.cacheReadTokens / cacheDenom) * 100) : null;

  return (
    <Widget title="TOKENS" right={<span style={W.badge}>{props.snap?.models[0]?.replace("claude-", "") ?? "—"}</span>}>
      {!t ? (
        // Says which pane it would follow, so "no numbers" is legible rather
        // than looking broken.
        <div style={W.empty}>no claude session in this pane</div>
      ) : (
        <>
          <div style={W.bigNum}>{fmtTokens(total)}</div>
          {!t.wholeTree && (
            // Without a result message these are main-loop figures only: any
            // subagent's tokens are missing. Say so rather than presenting a
            // partial number as a total.
            <div style={W.caveat} title="No result record in this transcript, so subagent tokens are not included.">
              main loop only · excludes subagents
            </div>
          )}
          <Row label="input" value={fmtTokens(t.inputTokens)} />
          <Row label="output" value={fmtTokens(t.outputTokens)} />
          <Row label="cache read" value={fmtTokens(t.cacheReadTokens)} />
          <Row label="cache write" value={fmtTokens(t.cacheCreationTokens)} />
          {hit !== null && (
            <>
              <div style={W.barTrack}>
                <div style={{ ...W.barFill, width: `${hit}%` }} />
              </div>
              <Row label="cache hit" value={`${hit}%`} dim />
            </>
          )}
        </>
      )}
    </Widget>
  );
}

/** Live subagent list -- the thing the CLI collapses to a spinner. */
export function AgentsWidget(props: { snap: Snapshot | null; onSelect?: (id: string) => void }) {
  const agents = props.snap?.agents ?? [];
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <Widget title="AGENTS" right={<span style={W.badge}>{agents.length}</span>}>
      {agents.length === 0 ? (
        <div style={W.empty}>no subagents</div>
      ) : (
        <>
          {running > 0 && <div style={{ ...W.note, color: "#d29922" }}>{running} running</div>}
          {agents.slice(0, 12).map((a) => (
            <div
              key={a.id}
              style={{ ...W.agentRow, paddingLeft: 4 + Math.max(0, a.depth - 1) * 9 }}
              onClick={() => props.onSelect?.(a.id)}
              title={`${a.name}${a.label ? ` · ${a.label}` : ""}\n${a.toolCalls} tool calls`}
            >
              <span style={{ color: statusColor(a.status) }}>
                {a.status === "running" ? "◉" : a.status === "error" ? "✖" : "●"}
              </span>
              <span style={W.agentName}>{a.label ?? a.name}</span>
              <span style={W.agentTok}>{fmtTokens(a.tokens)}</span>
            </div>
          ))}
          {agents.length > 12 && (
            <div style={W.note}>+{agents.length - 12} more — open the Agents pane</div>
          )}
        </>
      )}
    </Widget>
  );
}

/** Skill context cost: what every session pays for, before you type anything. */
function Row(props: { label: string; value: string; dim?: boolean }) {
  return (
    <div style={W.row}>
      <span style={{ color: props.dim ? C.faint : C.dim }}>{props.label}</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: props.dim ? C.faint : C.fg }}>{props.value}</span>
    </div>
  );
}

const W: Record<string, React.CSSProperties> = {
  card: { background: "#0f0f14", border: `1px solid ${C.line}`, borderRadius: 8,
          marginBottom: 9, overflow: "hidden" },
  head: { display: "flex", alignItems: "center", padding: "5px 9px", fontSize: 10,
          letterSpacing: 0.6, color: C.faint, borderBottom: `1px solid ${C.line}` },
  body: { padding: "7px 9px" },
  badge: { fontSize: 10, color: C.dim, background: "#1a1a22", borderRadius: 9,
           padding: "1px 7px" },
  bigNum: { fontSize: 21, color: C.fg, lineHeight: "26px", fontVariantNumeric: "tabular-nums" },
  row: { display: "flex", fontSize: 11, lineHeight: "17px" },
  note: { fontSize: 10, color: C.faint, marginBottom: 4 },
  caveat: { fontSize: 10, color: "#d29922", marginBottom: 6, cursor: "help" },
  empty: { fontSize: 11, color: "#33333c", padding: "6px 0" },
  barTrack: { height: 3, background: "#1e1e26", borderRadius: 2, margin: "7px 0 4px" },
  barFill: { height: "100%", background: C.green, borderRadius: 2 },
  agentRow: { display: "flex", gap: 5, alignItems: "center", fontSize: 11,
              lineHeight: "18px", cursor: "default" },
  agentName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
               color: C.dim },
  agentTok: { color: C.faint, fontVariantNumeric: "tabular-nums" },
};
