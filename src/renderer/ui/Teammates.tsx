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
import { TerminalPane } from "../panes/Terminal.js";

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
  /**
   * The window this teammate's pane was moved into, once isolated.
   *
   * Claude Code tiles every teammate into one window, so attaching to the
   * pane still renders all five -- `-t <pane>` only picks the active one.
   * The pane is given a window of its own first, and that window is what the
   * terminal attaches to. Null means not yet isolated (or tmux refused), and
   * the terminal waits rather than attaching to the tiled view.
   */
  const [windowId, setWindowId] = useState<string | null>(null);
  /** Where the pane came from, so closing can put it back. */
  const originRef = useRef<string | null>(null);

  const paneId = props.mate.tmuxPaneId!;

  /*
   * Isolate on entering attached mode, and put it back on leaving.
   *
   * The rejoin is in the cleanup rather than in the close handler so it also
   * runs when the tab is switched away or the component unmounts -- closing
   * is not the only way to stop looking at a teammate.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await window.th.teamIsolate(props.socket, paneId);
      if (cancelled || !r) return;
      originRef.current = r.origin;
      setWindowId(r.window);
    })();
    return () => {
      cancelled = true;
      setWindowId(null);
      const origin = originRef.current;
      if (origin) void window.th.teamRejoin(props.socket, paneId, origin);
    };
  }, [props.socket, paneId]);


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

      {/*
        * A real terminal on the teammate's isolated window.
        *
        * There is no second "snapshot" mode any more. It polled
        * `capture-pane` every 1.2s into a <pre> and offered a one-line text
        * box, and every reason to keep it turned out to be unreachable: the
        * whole feature needs tmux to detect a teammate at all, so it cannot
        * cover a missing binary, and against a dead server a capture returns
        * nothing while an attach at least says "no sessions". It was a
        * subprocess every 1.2s and a second code path, for strictly less.
        */}
      <div style={S.term}>
        {windowId ? (
          <TerminalPane
            /*
             * Keyed by window, and attached to the window rather than the
             * pane: a pane target only sets which pane is active, leaving the
             * client rendering all five tiled. The id includes the window so
             * the PTY is reused across remounts -- reopening the tab returns
             * to the same attachment instead of starting a second.
             */
            paneId={`mate:${props.socket}:${windowId}`}
            cmd="tmux"
            args={["-L", props.socket, "attach", "-t", windowId]}
            cwd={props.mate.cwd}
            focused
          />
        ) : (
          <div style={S.termWait}>attaching to {props.mate.name}…</div>
        )}
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
  term: { flex: 1, minHeight: 0, overflow: "hidden" },
  termWait: { padding: 12, color: C.faint, fontSize: 11 },
  view: {
    display: "flex", flexDirection: "column", flexShrink: 0,
    /*
     * Taller than the snapshot needed. An attached terminal resizes the tmux
     * pane to fit this box, and Claude's interface reflows to whatever it is
     * given -- at 260px it had about eight usable rows.
     */
    height: 420, margin: "0 10px 8px", borderRadius: 8,
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
};
