/**
 * Stats-rail widgets: what each agent is doing, and what it is costing.
 *
 * Everything here reads the transcript Claude Code already writes, so nothing
 * needs instrumenting. Numbers come from modelUsage rather than usage --
 * usage excludes subagent tokens entirely, which for an app built around
 * subagents would make every figure quietly wrong.
 *
 * The rail is one card per claude pane, not one card for the workspace. With
 * several agents running in a tab, a single card can only ever describe one of
 * them, and it is not obvious from looking at it which -- so the card leads
 * with the pane it belongs to and the session id it is reading.
 *
 * Two different numbers live here and are deliberately kept apart:
 *
 *   - CONTEXT is occupancy: what the model was holding on the last turn,
 *     against the window it was served with. This is what `/context` shows.
 *   - SPEND is cumulative: every token the session has been billed for. It
 *     grows forever and says nothing about how full the window is.
 *
 * Conflating them is the reason the old single TOKENS card was confusing: it
 * showed a 1.2M cumulative figure that looked alarming next to a 1M window it
 * had nothing to do with.
 */

import { useEffect, useState, type ReactNode } from "react";
import { C } from "./Chrome.js";

export interface AgentWire {
  id: string; parentId: string | null; name: string; label?: string;
  model?: string; status: string; startedAt?: number; endedAt?: number;
  depth: number; tokens: number; toolCalls: number; files: string[]; lastText?: string;
}

export interface ContextWire {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  model?: string;
  at?: number;
  limit: number;
  limitKnown: boolean;
}

/** One row of the context breakdown, as it crosses IPC. */
export interface CategoryWire {
  key: string;
  label: string;
  tokens: number;
  count: number;
  detail: string;
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
  context?: ContextWire;
  categories: CategoryWire[];
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

/** Model id as a badge: the family and version, without the vendor prefix. */
const shortModel = (m: string | undefined): string =>
  m ? m.replace(/^anthropic[./]/, "").replace(/^claude-/, "") : "—";

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
    // An empty cwd means "nothing is watching": no claude pane in this
    // workspace, or the rail is collapsed and nothing would render the result.
    // Idle rather than polling -- this fires every 2.5s for the life of the
    // app, so a poll nobody reads is a real cost, not a theoretical one.
    if (!cwd) {
      setSnap(null);
      return;
    }
    let alive = true;
    /*
     * One read at a time, and results applied in order.
     *
     * Parsing a long transcript can outlast the interval, so without the
     * in-flight guard the polls overlap and a slower older response can land
     * after a newer one -- the pane then shows counts that go backwards. The
     * sequence number makes a late reply detectable rather than trusted.
     */
    let inFlight = false;
    let issued = 0;
    let applied = 0;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      const seq = ++issued;
      try {
        const s = (await window.th.claudeSnapshot(cwd, paneId)) as Snapshot | null;
        if (!alive || seq < applied) return;
        applied = seq;
        /*
         * Hold the last good snapshot rather than blanking on a miss.
         *
         * A single read can come back null while a session is very much alive
         * -- the transcript is mid-write, or the pty has not registered yet --
         * and dropping to null there empties the pane for 2 seconds. Only an
         * explicit change of target (below) clears it.
         */
        if (s) setSnap(s);
      } finally {
        inFlight = false;
      }
    };
    // A new target must not keep showing the previous one's numbers.
    setSnap(null);
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

/**
 * A label that can explain itself.
 *
 * Native `title` tooltips were not enough here: the cache figures are the ones
 * people actually have questions about, and a 40-word answer does not belong
 * in a tooltip that vanishes on mouse-out. Clicking the mark opens the note
 * inline and it stays open until clicked again.
 */
function InfoDot(props: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      style={{ ...W.info, color: props.open ? C.accent : C.faint }}
      onClick={props.onToggle}
      aria-expanded={props.open}
      aria-label={`What is ${props.label}?`}
      title={`What is ${props.label}?`}
    >
      ⓘ
    </button>
  );
}

function Note(props: { children: ReactNode }) {
  return <div style={W.noteBox}>{props.children}</div>;
}

/** A metered row: label, value, optional explainer. */
function Row(props: {
  label: string;
  value: string;
  dim?: boolean;
  info?: { open: boolean; onToggle: () => void };
}) {
  return (
    <div style={W.row}>
      <span style={{ color: props.dim ? C.faint : C.dim }}>{props.label}</span>
      {props.info && (
        <InfoDot open={props.info.open} onToggle={props.info.onToggle} label={props.label} />
      )}
      <div style={{ flex: 1 }} />
      <span style={{ color: props.dim ? C.faint : C.fg }}>{props.value}</span>
    </div>
  );
}

/**
 * Window occupancy, segmented by how each part of the prompt was paid for.
 *
 * The segments are the same three numbers the API reports for the turn, so the
 * bar is not an approximation of the context -- it is the context.
 */
function ContextMeter(props: { ctx: ContextWire }) {
  const c = props.ctx;
  const pct = (n: number) => `${Math.min(100, (n / c.limit) * 100)}%`;
  const used = Math.round((c.totalTokens / c.limit) * 100);
  return (
    <>
      <div style={W.bigNum}>
        {fmtTokens(c.totalTokens)}
        <span style={W.ofLimit}>/{fmtTokens(c.limit)}</span>
        <span style={W.pct}>{used}%</span>
      </div>
      {!c.limitKnown && (
        <div style={W.caveat} title="This model is not in the bundled window table, so the denominator is a 200k assumption rather than a fact.">
          window assumed · {shortModel(c.model)} not in table
        </div>
      )}
      <div style={W.meter}>
        <div style={{ ...W.seg, width: pct(c.cacheReadTokens), background: C.green }} />
        <div style={{ ...W.seg, width: pct(c.cacheCreationTokens), background: "#d29922" }} />
        <div style={{ ...W.seg, width: pct(c.inputTokens), background: C.accent }} />
      </div>
      <div style={W.legend}>
        <Key color={C.green} label="cached" value={fmtTokens(c.cacheReadTokens)} />
        <Key color="#d29922" label="written" value={fmtTokens(c.cacheCreationTokens)} />
        <Key color={C.accent} label="fresh" value={fmtTokens(c.inputTokens)} />
      </div>
    </>
  );
}

/**
 * Where the context goes, category by category.
 *
 * Every row is measured from this session's own transcript -- the CLI records
 * each block of text it injects, so these are the skills, tools, agents and
 * files that went into *this* prompt, not an inventory of the machine. The one
 * thing genuinely missing is the system prompt, which is never written to disk
 * anywhere; it falls into the remainder along with the conversation, and that
 * row is named rather than quietly dropped.
 */
function Breakdown(props: { rows: CategoryWire[]; contextTotal?: number }) {
  const measured = props.rows.reduce((n, r) => n + r.tokens, 0);
  const rest =
    props.contextTotal !== undefined
      ? Math.max(0, props.contextTotal - measured)
      : undefined;
  return (
    <div style={W.breakdown}>
      {props.rows.length === 0 && <div style={W.empty}>nothing injected yet</div>}
      {props.rows.map((c) => (
        <div key={c.key} style={W.costRow} title={c.detail}>
          <span style={W.costLabel}>
            {c.label}
            <span style={W.costCount}> {c.count}</span>
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ color: C.fg }}>{fmtTokens(c.tokens)}</span>
        </div>
      ))}
      <div style={{ ...W.costRow, ...W.costTotal }}>
        <span style={{ color: C.dim }}>measured</span>
        <div style={{ flex: 1 }} />
        <span>{fmtTokens(measured)}</span>
      </div>
      {rest !== undefined && (
        <div style={W.costRow} title="The conversation itself, plus the CLI's system prompt and the schemas of its always-loaded tools -- none of which is ever written to a transcript. On a long session this is mostly the conversation.">
          <span style={{ color: C.faint }}>messages &amp; system prompt</span>
          <div style={{ flex: 1 }} />
          <span style={{ color: C.faint }}>{fmtTokens(rest)}</span>
        </div>
      )}
      <div style={W.costFoot}>
        Measured from this session's transcript at 4 bytes per token. A tool
        costs its name until something uses it, then its schema.
      </div>
    </div>
  );
}

function Key(props: { color: string; label: string; value: string }) {
  return (
    <span style={W.key}>
      <span style={{ ...W.dot, background: props.color }} />
      {props.label} {props.value}
    </span>
  );
}

/**
 * One card per claude pane.
 *
 * Polls on its own rather than being handed a snapshot: each pane follows a
 * different session, and the poll has to be keyed to the pane it belongs to.
 */
export function SessionCard(props: {
  /** Pane identity, as shown on the pane header. */
  title: string;
  paneId: string;
  cwd: string;
  focused?: boolean;
  /** Clicking the card focuses the pane it describes. */
  onSelect?: () => void;
  pollMs?: number;
}) {
  const snap = useSnapshot(props.cwd, props.pollMs ?? 2500, props.paneId);
  /** Which explainer is open, if any. One at a time keeps the card short. */
  const [note, setNote] = useState<string | null>(null);
  /**
   * Whether the category breakdown is showing. Collapsed by default to keep
   * the card glanceable -- the rows ride along with the poll, so opening it
   * costs nothing and needs no fetch.
   */
  const [costOpen, setCostOpen] = useState(false);
  const toggle = (k: string) => () => setNote((v) => (v === k ? null : k));
  const info = (k: string) => ({ open: note === k, onToggle: toggle(k) });

  const t = snap?.totals;
  const ctx = snap?.context;
  const agents = snap?.agents ?? [];
  const running = agents.filter((a) => a.status === "running").length;

  // Denominator is every input token the session was charged for, however it
  // was charged -- output is excluded because it was never a cache candidate.
  const cacheDenom = t ? t.cacheReadTokens + t.inputTokens + t.cacheCreationTokens : 0;
  const hit = cacheDenom ? Math.round((t!.cacheReadTokens / cacheDenom) * 100) : null;
  /*
   * Net saving, in full-price input tokens.
   *
   * A cache read bills at 0.1x, so each one avoids 0.9 of a token. A cache
   * write bills at 1.25x, so each one costs an extra 0.25. Both TTLs exist
   * and the 1h one writes at 2x, so this is the 5-minute figure and is
   * therefore the conservative direction only for reads -- said plainly in
   * the note rather than hidden behind a rounded number.
   */
  const saved = t ? t.cacheReadTokens * 0.9 - t.cacheCreationTokens * 0.25 : 0;

  return (
    <section style={{ ...W.card, ...(props.focused ? W.cardFocused : null) }}>
      <header style={W.head} onClick={props.onSelect} title="Focus this pane">
        <span style={{ color: props.focused ? C.fg : C.dim }}>{props.title}</span>
        <div style={{ flex: 1 }} />
        <span style={W.badge}>{shortModel(ctx?.model ?? snap?.models[0])}</span>
      </header>
      <div style={W.body}>
        {!snap ? (
          // Says which pane it would follow, so "no numbers" is legible rather
          // than looking broken.
          <div style={W.empty}>no claude session in this pane yet</div>
        ) : (
          <>
            <div style={W.section}>CONTEXT</div>
            {ctx ? (
              <ContextMeter ctx={ctx} />
            ) : (
              <div style={W.empty}>nothing sent yet</div>
            )}
            <button
              style={W.disclose}
              onClick={() => setCostOpen((v) => !v)}
              aria-expanded={costOpen}
            >
              {costOpen ? "▾" : "▸"} what's loaded
            </button>
            {costOpen && (
              <Breakdown rows={snap.categories ?? []} contextTotal={ctx?.totalTokens} />
            )}

            <div style={{ ...W.section, marginTop: 10 }}>SPEND · whole session</div>
            {!t?.wholeTree && (
              // Without a result message these are main-loop figures only: any
              // subagent's tokens are missing. Say so rather than presenting a
              // partial number as a total.
              <div style={W.caveat} title="No result record in this transcript, so subagent tokens are not included.">
                main loop only · excludes subagents
              </div>
            )}
            <Row label="input" value={fmtTokens(t?.inputTokens ?? 0)} />
            <Row label="output" value={fmtTokens(t?.outputTokens ?? 0)} />
            <Row label="cache read" value={fmtTokens(t?.cacheReadTokens ?? 0)} info={info("read")} />
            {note === "read" && (
              <Note>
                Prompt tokens served from an existing cache entry instead of being
                reprocessed, billed at about <b>0.1×</b> normal input. Every turn
                re-sends the entire conversation, so on a long session almost all
                of it is an unchanged prefix — that prefix is the cache read.
              </Note>
            )}
            <Row label="cache write" value={fmtTokens(t?.cacheCreationTokens ?? 0)} info={info("write")} />
            {note === "write" && (
              <Note>
                Prompt tokens written into a <i>new</i> cache entry, billed at about
                <b> 1.25×</b> normal input (2× on a 1-hour TTL). You pay this on the
                first turn, whenever the 5-minute entry expires, and whenever
                anything early in the prompt changes — a new tool, an edited system
                prompt, a switched model. A cache write with no reads after it is
                pure overhead, which is what a churning prefix looks like here.
              </Note>
            )}
            {hit !== null && (
              <>
                <div style={W.barTrack}>
                  <div style={{ ...W.barFill, width: `${hit}%` }} />
                </div>
                <Row label="cache hit" value={`${hit}%`} dim info={info("hit")} />
                {note === "hit" && (
                  <Note>
                    read ÷ (read + fresh input + write). <b>90% is the goal, not a
                    warning</b> — it means nine tenths of what gets re-sent each turn
                    bills at a tenth of list price. Roughly{" "}
                    <b>{fmtTokens(Math.max(0, Math.round(saved)))}</b> full-price input
                    tokens avoided so far (0.9 × reads − 0.25 × writes, at the
                    5-minute rate). It drops when the prefix changes or the entry
                    expires, so a falling number here is the thing worth chasing.
                  </Note>
                )}
              </>
            )}

            <div style={{ ...W.section, marginTop: 10 }}>
              AGENTS
              <span style={{ ...W.badge, marginLeft: 6 }}>{agents.length}</span>
              {running > 0 && <span style={W.runningTag}>{running} running</span>}
            </div>
            {agents.length === 0 ? (
              <div style={W.empty}>no subagents</div>
            ) : (
              <>
                {agents.slice(0, 8).map((a) => (
                  <div
                    key={a.id}
                    style={{ ...W.agentRow, paddingLeft: Math.max(0, a.depth - 1) * 9 }}
                    title={`${a.name}${a.label ? ` · ${a.label}` : ""}\n${a.toolCalls} tool calls`}
                  >
                    <span style={{ color: statusColor(a.status) }}>
                      {a.status === "running" ? "◉" : a.status === "error" ? "✖" : "●"}
                    </span>
                    <span style={W.agentName}>{a.label ?? a.name}</span>
                    <span style={W.agentTok}>{fmtTokens(a.tokens)}</span>
                  </div>
                ))}
                {agents.length > 8 && (
                  <div style={W.note}>+{agents.length - 8} more — open the Agents pane</div>
                )}
              </>
            )}

            <div style={W.footer} title={snap.sessionId}>
              {snap.sessionId.slice(0, 8)} · {fmtDur(snap.elapsedMs)} to parse
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const W: Record<string, React.CSSProperties> = {
  card: { background: "#0f0f14", border: `1px solid ${C.line}`, borderRadius: 8,
          marginBottom: 9, overflow: "hidden" },
  cardFocused: { border: `1px solid ${C.accent}` },
  head: { display: "flex", alignItems: "center", padding: "5px 9px", fontSize: 10,
          letterSpacing: 0.6, color: C.faint, borderBottom: `1px solid ${C.line}`,
          cursor: "pointer" },
  body: { padding: "7px 9px" },
  section: { fontSize: 9, letterSpacing: 0.7, color: C.faint, marginBottom: 3,
             display: "flex", alignItems: "center" },
  badge: { fontSize: 10, color: C.dim, background: "#1a1a22", borderRadius: 9,
           padding: "1px 7px" },
  runningTag: { fontSize: 9, color: "#d29922", marginLeft: 6, letterSpacing: 0 },
  bigNum: { fontSize: 19, color: C.fg, lineHeight: "24px", fontVariantNumeric: "tabular-nums" },
  ofLimit: { fontSize: 11, color: C.faint, marginLeft: 1 },
  pct: { fontSize: 11, color: C.dim, marginLeft: 6 },
  meter: { display: "flex", height: 5, background: "#1e1e26", borderRadius: 3,
           overflow: "hidden", margin: "6px 0 5px" },
  seg: { height: "100%" },
  legend: { display: "flex", flexWrap: "wrap", gap: 7, fontSize: 9.5, color: C.faint },
  key: { display: "inline-flex", alignItems: "center", gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3, display: "inline-block" },
  row: { display: "flex", alignItems: "center", fontSize: 11, lineHeight: "17px" },
  disclose: { background: "none", border: "none", padding: "4px 0 2px", fontSize: 10,
              color: C.faint, cursor: "pointer", letterSpacing: 0.3 },
  breakdown: { borderLeft: `1px solid ${C.line}`, paddingLeft: 7, marginBottom: 4 },
  costRow: { display: "flex", alignItems: "center", fontSize: 10.5, lineHeight: "16px",
             color: C.dim, cursor: "help" },
  costLabel: { color: C.dim },
  costCount: { color: "#33333c" },
  costTotal: { borderTop: `1px solid ${C.line}`, marginTop: 3, paddingTop: 3, color: C.fg },
  onDemand: { color: "#33333c", fontSize: 9.5, marginRight: 5 },
  costFoot: { fontSize: 9, lineHeight: "12px", color: "#33333c", marginTop: 5 },
  info: { background: "none", border: "none", padding: "0 0 0 4px", fontSize: 9.5,
          cursor: "pointer", lineHeight: "17px" },
  noteBox: { fontSize: 10, lineHeight: "14px", color: C.dim, background: "#14141b",
             border: `1px solid ${C.line}`, borderRadius: 5, padding: "5px 6px",
             margin: "3px 0 5px" },
  note: { fontSize: 10, color: C.faint, marginBottom: 4 },
  caveat: { fontSize: 10, color: "#d29922", marginBottom: 6, cursor: "help" },
  empty: { fontSize: 11, color: "#33333c", padding: "3px 0" },
  barTrack: { height: 3, background: "#1e1e26", borderRadius: 2, margin: "7px 0 4px" },
  barFill: { height: "100%", background: C.green, borderRadius: 2 },
  agentRow: { display: "flex", gap: 5, alignItems: "center", fontSize: 11,
              lineHeight: "18px", cursor: "default" },
  agentName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
               color: C.dim },
  agentTok: { color: C.faint, fontVariantNumeric: "tabular-nums" },
  footer: { fontSize: 9, color: "#33333c", marginTop: 8, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "help" },
};
