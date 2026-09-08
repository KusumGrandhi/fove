/**
 * Keel: what the last turn changed.
 *
 * An overlay, not a mode and not a replacement for the panes. It opens on ⌘L,
 * closes on Escape, and everything underneath keeps running -- no pane
 * unmounts, no PTY dies, the agent does not pause. That is the whole design
 * decision: if the summary cannot tell you enough, you close it and read the
 * code, so nothing here has to be complete enough to live in.
 *
 * Layered at z-index 50, below the command palette and below Claude's blocking
 * diff (both 60), so an approval Claude is waiting on always wins.
 *
 * **It never claims authorship.** A change that appeared between two snapshots
 * was made *during* the turn, by something -- usually the agent, sometimes you,
 * a formatter, a watcher, or an agent in another pane. The vocabulary here says
 * "changed during this turn" and never "the agent did this", and the same rule
 * is pinned by a test in `changeset.test.ts`.
 */

import { useEffect, useRef, useState } from "react";
import { C } from "./Chrome.js";
import type { ChangeSet, ChangeKind, FileChange } from "../../shared/changeset.js";

interface TurnLite {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
}

export interface TurnReview {
  turn: TurnLite | null;
  history: TurnLite[];
  changes: ChangeSet | null;
  unbounded?: "not-watching" | "not-a-repo" | "running";
  summary: string;
  confidence: { clean: number; muddied: number; reliable: boolean } | null;
  running: boolean;
  fromPane: boolean;
}

/** Colour by what kind of change it is, matching the risk ordering. */
const KIND_COLOR: Record<ChangeKind, string> = {
  added: "#3fb950",
  resolved: "#e5534b",
  modified: "#d29922",
  unchanged: "#5a5a63",
};

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "new",
  resolved: "gone",
  modified: "edited",
  unchanged: "untouched",
};

/**
 * Strip IDE context the editor prepends to a prompt.
 *
 * `<ide_selection>` wraps the code you had highlighted and is genuinely part of
 * the turn -- it is not synthetic, so `turns.ts` keeps it. But it is context,
 * not the question, and showing 400 characters of Python where the prompt
 * should be makes the history unreadable.
 */
function cleanPrompt(text: string): string {
  const stripped = text.replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "").trim();
  return stripped || text.slice(0, 200);
}

const rel = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const dur = (t: TurnLite): string => {
  if (t.endedAt === undefined) return "running";
  const s = Math.round((t.endedAt - t.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function Keel(props: {
  review: TurnReview | null;
  loading: boolean;
  cwd: string;
  onClose: () => void;
  onOpenFile: (path: string, line?: number) => void;
  onRefresh: () => void;
}) {
  const { review } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Escape closes. Captured, because a pane underneath may also listen for it
  // and the overlay is the thing in front.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  useEffect(() => { hostRef.current?.focus(); }, []);

  const changed = review?.changes?.changed ?? [];
  const carried = review?.changes?.carried ?? [];

  return (
    <div style={S.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div style={S.panel} ref={hostRef} tabIndex={-1}>
        <header style={S.head}>
          <span style={S.brand}>keel</span>
          <span style={S.cwd} title={props.cwd}>{props.cwd.split("/").pop()}</span>
          <div style={{ flex: 1 }} />
          {review?.running && (
            <span style={S.runningPill}>
              <span style={S.dot} />turn in progress
            </span>
          )}
          <button style={S.ghost} onClick={props.onRefresh} title="Re-read the session">
            refresh
          </button>
          <button style={S.ghost} onClick={props.onClose}>close <span style={S.key}>esc</span></button>
        </header>

        {props.loading && !review ? (
          <div style={S.empty}>reading the session…</div>
        ) : !review?.turn ? (
          <div style={S.empty}>
            <div style={{ color: C.dim, marginBottom: 6 }}>no turns in this workspace yet</div>
            <div style={S.emptyHint}>
              Keel opens on the last thing you asked Claude to do. Start a turn and come back.
            </div>
          </div>
        ) : (
          <div style={S.body}>
            {/* --- the prompt this turn answered --- */}
            <section style={S.promptBox}>
              <div style={S.eyebrow}>the ask</div>
              <p style={S.prompt}>{cleanPrompt(review.turn.prompt)}</p>
              <div style={S.metaRow}>
                {!review.fromPane && (
                  // The focused pane's own session had nothing, so this came
                  // from the workspace's newest. Say so -- it may not be the
                  // session being looked at.
                  <span style={S.tag} title="the focused pane has no turns of its own yet">
                    newest session
                  </span>
                )}
                <span>{rel(review.turn.startedAt)}</span>
                <span>·</span>
                <span>{dur(review.turn)}</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: C.dim }}>{review.summary}</span>
              </div>
            </section>

            {/* --- what it changed, or why we cannot say --- */}
            {review.changes === null ? (
              <Unbounded reason={review.unbounded} />
            ) : (
              <>
                {review.confidence && !review.confidence.reliable && (
                  <div style={S.warn}>
                    <b style={{ color: "#d29922" }}>attribution is weak here.</b>{" "}
                    {review.confidence.muddied} file{review.confidence.muddied === 1 ? " was" : "s were"}{" "}
                    already in flight before this turn started, against{" "}
                    {review.confidence.clean} that {review.confidence.clean === 1 ? "was" : "were"} not.
                    What this turn did cannot be separated from what was already there.
                  </div>
                )}

                <section>
                  <div style={S.eyebrow}>
                    changed during this turn
                    <span style={S.count}>{changed.length}</span>
                  </div>
                  {changed.length === 0 ? (
                    <div style={S.none}>nothing moved on disk</div>
                  ) : (
                    <div style={S.list}>
                      {changed.map((f) => (
                        <FileRow
                          key={f.path}
                          file={f}
                          open={selected === f.path}
                          onToggle={() => setSelected((s) => (s === f.path ? null : f.path))}
                          onOpen={() => props.onOpenFile(`${props.cwd}/${f.path}`)}
                        />
                      ))}
                    </div>
                  )}
                </section>

                {carried.length > 0 && (
                  <section>
                    <div style={S.eyebrow}>
                      already dirty, unchanged by this turn
                      <span style={S.count}>{carried.length}</span>
                    </div>
                    <div style={S.list}>
                      {carried.map((f) => (
                        <div key={f.path} style={{ ...S.row, opacity: 0.55 }}>
                          <span style={{ ...S.kind, color: KIND_COLOR.unchanged }}>—</span>
                          <span style={S.path}>{f.path}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* The honest line. Not "safe" -- "nothing was checking". */}
                <div style={S.coverage}>
                  <b style={{ color: C.fg }}>{changed.length}</b> file
                  {changed.length === 1 ? "" : "s"} changed, and nothing checked{" "}
                  {changed.length === 1 ? "it" : "them"} against a rule.
                  <span style={{ color: C.faint }}> Intents land next.</span>
                </div>
              </>
            )}

            {/* --- earlier turns, for context --- */}
            {review.history.length > 1 && (
              <section>
                <div style={S.eyebrow}>earlier turns</div>
                <div style={S.list}>
                  {review.history.slice(1, 6).map((t) => (
                    <div key={t.id} style={S.histRow} title={cleanPrompt(t.prompt)}>
                      <span style={S.histWhen}>{rel(t.startedAt)}</span>
                      <span style={S.histPrompt}>{cleanPrompt(t.prompt).split("\n")[0]}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Why there is no change set. Each reason needs a different response. */
function Unbounded(props: { reason?: "not-watching" | "not-a-repo" | "running" }) {
  if (props.reason === "not-a-repo") {
    return (
      <div style={S.warn}>
        This workspace is not a git repository, so there is no way to tell what changed.
      </div>
    );
  }
  return (
    <div style={S.warn}>
      <b style={{ color: "#d29922" }}>no boundary for this turn.</b>{" "}
      fove was not watching this workspace when the turn began, so it cannot separate
      what the turn did from everything else uncommitted. It is watching now —
      the next turn will have a proper change set.
    </div>
  );
}

function FileRow(props: {
  file: FileChange;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { file } = props;
  return (
    <div style={S.row} onClick={props.onToggle}>
      <span style={{ ...S.kind, color: KIND_COLOR[file.kind] }}>{KIND_LABEL[file.kind]}</span>
      <span style={S.path} title={file.path}>{file.path}</span>
      {file.preexisting && file.kind !== "added" && (
        // Worth saying: this file was already dirty, so the turn is only part
        // of what is in it.
        <span style={S.tag} title="already had uncommitted changes before this turn">
          was dirty
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button
        style={S.openBtn}
        onClick={(e) => { e.stopPropagation(); props.onOpen(); }}
      >
        open
      </button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)",
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    paddingTop: "6vh", zIndex: 50,
    animation: "fove-fade-in 120ms ease-out",
  },
  panel: {
    width: "min(920px, 92%)", maxHeight: "84vh", display: "flex", flexDirection: "column",
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12,
    boxShadow: "0 24px 64px rgba(0,0,0,0.55)", overflow: "hidden", outline: "none",
    animation: "fove-rise 160ms ease-out",
  },
  head: {
    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
    background: C.chrome, borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  brand: { color: C.fg, fontSize: 13, fontWeight: 600, letterSpacing: 0.2 },
  cwd: { color: C.faint, fontSize: 11, fontFamily: "Menlo, monospace" },
  runningPill: {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5,
    color: C.accent, border: `1px solid ${C.accent}55`, background: `${C.accent}14`,
    borderRadius: 20, padding: "2px 9px",
  },
  dot: {
    width: 6, height: 6, borderRadius: "50%", background: C.accent,
    animation: "fove-pulse 1.6s ease-in-out infinite",
  },
  ghost: {
    padding: "3px 10px", borderRadius: 5, border: `1px solid ${C.line}`,
    background: "transparent", color: C.dim, fontSize: 11, cursor: "pointer",
    fontFamily: "system-ui",
  },
  key: { opacity: 0.55, marginLeft: 5, fontSize: 10 },

  body: { overflowY: "auto", padding: "14px 16px 18px", display: "flex", flexDirection: "column", gap: 16 },
  empty: { padding: "44px 20px", textAlign: "center", color: C.faint, fontSize: 12 },
  emptyHint: { fontSize: 11, color: C.faint, maxWidth: 420, margin: "0 auto", lineHeight: 1.6 },

  promptBox: {
    background: C.bg, border: `1px solid ${C.line}`, borderRadius: 9, padding: "11px 13px",
  },
  eyebrow: {
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 9.5, letterSpacing: 0.9, textTransform: "uppercase",
    color: C.faint, marginBottom: 8,
  },
  count: {
    fontSize: 9.5, color: C.dim, background: C.chromeHi, borderRadius: 9,
    padding: "0 6px", letterSpacing: 0,
  },
  prompt: {
    margin: "0 0 9px", fontSize: 13.5, lineHeight: 1.55, color: C.fg,
    fontFamily: "system-ui", maxWidth: "72ch",
    display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden",
  },
  metaRow: {
    display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, color: C.faint,
    fontVariantNumeric: "tabular-nums",
  },

  warn: {
    padding: "10px 12px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
    color: C.dim, background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.3)",
    fontFamily: "system-ui",
  },

  list: { display: "flex", flexDirection: "column", gap: 2 },
  row: {
    display: "flex", alignItems: "center", gap: 9, padding: "5px 8px",
    borderRadius: 6, cursor: "pointer", fontSize: 11.5,
  },
  kind: {
    fontSize: 9.5, width: 52, flexShrink: 0, textTransform: "uppercase",
    letterSpacing: 0.5, fontFamily: "system-ui",
  },
  path: {
    fontFamily: "Menlo, monospace", fontSize: 11, color: C.fg,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "52ch",
  },
  tag: {
    fontSize: 9.5, color: C.faint, border: `1px solid ${C.line}`,
    borderRadius: 4, padding: "0 5px", flexShrink: 0,
  },
  openBtn: {
    padding: "1px 8px", borderRadius: 4, border: `1px solid ${C.line}`,
    background: "transparent", color: C.dim, fontSize: 10, cursor: "pointer",
    flexShrink: 0, fontFamily: "system-ui",
  },
  none: { fontSize: 11.5, color: C.faint, padding: "4px 8px", fontFamily: "system-ui" },

  coverage: {
    padding: "10px 12px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
    color: C.dim, background: C.bg, border: `1px dashed ${C.line}`, fontFamily: "system-ui",
  },

  histRow: {
    display: "flex", alignItems: "baseline", gap: 10, padding: "3px 8px",
    fontSize: 11, borderRadius: 5,
  },
  histWhen: {
    color: C.faint, fontSize: 10, width: 58, flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  histPrompt: {
    color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    fontFamily: "system-ui",
  },
};
