/**
 * Teammate sub-tabs: the swarm, surfaced without demanding attention.
 *
 * A teammate is a real `claude` process in a tmux pane -- distinct from a Task
 * subagent, which lives inside a transcript and can only be read after the
 * fact. Because it is a live process, it can be watched, interrupted and
 * talked to.
 *
 * The bar only exists while teammates are running: it appears when a swarm
 * starts and disappears when the last one finishes, so it costs nothing when
 * you are not using it. Nothing opens unless you click.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "./Chrome.js";

export interface Teammate {
  agentId: string;
  name: string;
  agentType?: string;
  model?: string;
  color?: string;
  prompt?: string;
  cwd?: string;
  tmuxPaneId?: string;
  alive?: boolean;
}

export interface Team {
  name: string;
  socket?: string;
  members: Teammate[];
}

/** tmux colour names -> the app's palette. */
const TINT: Record<string, string> = {
  blue: "#4a8cf0", green: "#3fb950", yellow: "#d29922", red: "#e5534b",
  magenta: "#c07cd8", cyan: "#3fb0c9", white: "#d8d8dc",
};

/** Poll for running teammates. Returns only live ones, lead excluded. */
export function useTeammates(intervalMs = 2500): { team: Team | null; live: Teammate[] } {
  const [team, setTeam] = useState<Team | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const teams = (await window.th.teamsList()) as Team[];
      // Newest team that still has a live member; otherwise nothing.
      const t = teams.find((x) => x.socket && x.members.some((m) => m.alive)) ?? null;
      if (alive) setTeam(t);
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(h); };
  }, [intervalMs]);

  const live = (team?.members ?? []).filter(
    (m) => m.alive && m.tmuxPaneId && m.tmuxPaneId !== "leader",
  );
  return { team, live };
}

/**
 * The bar itself. Renders nothing at all when no teammate is running, which is
 * the point: it must not take space or attention when there is no swarm.
 */
export function TeammateBar(props: {
  live: Teammate[];
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  if (props.live.length === 0) return null;
  return (
    <div style={S.bar}>
      <span style={S.label}>⛬ {props.live.length} running</span>
      {props.live.map((m) => {
        const on = props.openId === m.agentId;
        const tint = TINT[m.color ?? ""] ?? C.dim;
        return (
          <button
            key={m.agentId}
            onClick={() => props.onOpen(on ? null : m.agentId)}
            style={{
              ...S.tab,
              color: on ? C.fg : tint,
              background: on ? C.chromeHi : "transparent",
              borderColor: on ? tint : "transparent",
            }}
            title={m.prompt?.slice(0, 200) ?? m.name}
          >
            <span style={{ color: tint }}>●</span> {m.name}
          </button>
        );
      })}
      {props.openId && (
        <button onClick={() => props.onOpen(null)} style={S.close} title="Close viewer">
          ✕
        </button>
      )}
    </div>
  );
}

/** Live view of one teammate: its output, with a way to talk back. */
export function TeammateView(props: { socket: string; mate: Teammate; onClose: () => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  const paneId = props.mate.tmuxPaneId!;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const out = await window.th.teamCapture(props.socket, paneId, 400);
      if (!alive) return;
      setText(out.replace(/\n{3,}/g, "\n\n").trimEnd());
    };
    void tick();
    const h = setInterval(tick, 1200);
    return () => { alive = false; clearInterval(h); };
  }, [props.socket, paneId]);

  // Follow the tail unless the reader has scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const send = useCallback(async () => {
    const t = draft.trim();
    if (!t) return;
    setBusy(true);
    await window.th.teamSend(props.socket, paneId, t);
    setDraft("");
    setBusy(false);
  }, [draft, props.socket, paneId]);

  const interrupt = useCallback(async () => {
    await window.th.teamInterrupt(props.socket, paneId);
  }, [props.socket, paneId]);

  const tint = TINT[props.mate.color ?? ""] ?? C.accent;

  return (
    <div style={{ ...S.view, borderColor: tint }}>
      <div style={S.viewHead}>
        <span style={{ color: tint }}>● {props.mate.name}</span>
        <span style={S.viewMeta}>
          {props.mate.agentType}{props.mate.model ? ` · ${props.mate.model.replace("claude-", "")}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => void interrupt()} style={S.act} title="Send Escape to interrupt">
          interrupt
        </button>
        <button onClick={props.onClose} style={S.act}>close</button>
      </div>

      <pre
        ref={bodyRef}
        style={S.body}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {text || "(waiting for output…)"}
      </pre>

      <div style={S.inputRow}>
        <span style={{ color: tint }}>❯</span>
        <input
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // do not trigger app shortcuts while typing
            if (e.key === "Enter") void send();
          }}
          placeholder={`talk to ${props.mate.name}…`}
          style={S.input}
        />
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex", alignItems: "center", gap: 3, flexShrink: 0,
    padding: "3px 10px", background: "#12121a",
    borderBottom: `1px solid ${C.line}`, fontSize: 11,
  },
  label: { color: C.faint, fontSize: 10, marginRight: 6, letterSpacing: 0.4 },
  tab: {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "2px 9px", borderRadius: 5, border: "1px solid transparent",
    cursor: "pointer", fontSize: 11, fontFamily: "system-ui", whiteSpace: "nowrap",
  },
  close: {
    marginLeft: "auto", background: "transparent", border: "none",
    color: C.faint, cursor: "pointer", fontSize: 11,
  },
  view: {
    display: "flex", flexDirection: "column", flexShrink: 0,
    height: 260, margin: "0 10px 8px", borderRadius: 8,
    border: "1px solid", background: "#0d0d11", overflow: "hidden",
  },
  viewHead: {
    display: "flex", alignItems: "center", gap: 8, padding: "4px 9px",
    background: "#14141a", borderBottom: `1px solid ${C.line}`, fontSize: 11,
    flexShrink: 0,
  },
  viewMeta: { color: C.faint, fontSize: 10 },
  act: {
    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
    borderRadius: 4, padding: "1px 8px", cursor: "pointer", fontSize: 10,
  },
  body: {
    // minHeight:0 or a long transcript grows the box instead of scrolling it.
    flex: 1, minHeight: 0, margin: 0, padding: "7px 9px", overflowY: "auto",
    fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 11, lineHeight: "15px",
    color: C.dim, whiteSpace: "pre-wrap", wordBreak: "break-word",
  },
  inputRow: {
    display: "flex", alignItems: "center", gap: 7, padding: "5px 9px",
    borderTop: `1px solid ${C.line}`, flexShrink: 0,
  },
  input: {
    flex: 1, background: "transparent", border: "none", outline: "none",
    color: C.fg, fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 11,
  },
};
