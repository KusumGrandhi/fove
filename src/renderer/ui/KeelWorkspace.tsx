/**
 * Keel `4a` — the workspace.
 *
 * Three columns: the tree as a worklist, file cards in the middle, the agent
 * rail on the right. The handoff's step 1, and the screen that makes handing
 * work off trustable rather than merely reviewable — `2c` tells you what a turn
 * changed, this tells you what a file *is* before you agree to it.
 *
 * Still an overlay. Escape closes it and the panes underneath keep running; a
 * full-height three-column layout is a shape, not a commitment to living here.
 *
 * **Generated, never authored** (rule 2). Contract comes from the AST, purpose
 * from the first docstring on that surface, tone from git. Nothing on a card is
 * prose anyone maintains, which is what stops a card going stale.
 *
 * Where the handoff wants data that does not exist yet — invariants from
 * `.intent`, production numbers from telemetry — the section says what is
 * missing rather than being dropped or filled with plausible numbers.
 */

import { useEffect, useState } from "react";
import { SURFACE, BORDER, INK, BRAND, STATE, FONT, TYPE, RADIUS, cleanPrompt } from "./keel-tokens.js";
import { buildRows, attentionCount, type SortMode, type Tone, type WorklistFile } from "../../shared/worklist.js";
import { KeelHandoff } from "./KeelHandoff.js";
import type { HandoffState } from "../../shared/handoff.js";
import type { ContractEntry, FileContract } from "../../main/contract.js";

export interface WorklistWire {
  files: WorklistFile[];
  total: number;
  /** Files that moved in the turn window. Zero means every row is borrowed. */
  changedCount: number;
  /** Rows taken from the last commit because the tree was clean. */
  fromHistory: number;
}
export interface CardWire {
  contract: FileContract;
  purpose: string;
  purposeInferred: boolean;
}

/** Row colours, from the handoff's tone table. */
const TONE_FG: Record<Tone, string> = {
  failing: STATE.bad,
  drifted: STATE.warn,
  active: INK.i1,
  changed: INK.i1,
  normal: "rgba(253,253,252,.75)",
  quiet: "rgba(253,253,252,.5)",
};

/** Left-edge colour of a card, by the state of its file. */
const TONE_EDGE: Record<Tone, string> = {
  failing: STATE.bad,
  drifted: STATE.warn,
  active: BRAND.brand,
  changed: STATE.warn,
  normal: "rgba(210,204,192,.35)",
  quiet: "rgba(210,204,192,.22)",
};

export function KeelWorkspace(props: {
  cwd: string;
  worklist: WorklistWire | null;
  /** Cards for the open files, keyed by path. */
  cards: Record<string, CardWire | undefined>;
  open: string[];
  agent: { task?: string; running: boolean; blocked?: string } | null;
  handoff: HandoffState;
  onStart: (ticket: string, budgetUSD: number) => void;
  onApprove: () => void;
  onReplan: (note: string) => void;
  onStopHandoff: () => void;
  onResetHandoff: () => void;
  onOpenFile: (path: string) => void;
  onOpenInPane: (path: string) => void;
  onClose: () => void;
  onShowTurn: () => void;
  onShowIntents: () => void;
}) {
  const [sort, setSort] = useState<SortMode>("attention");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  const files = props.worklist?.files ?? [];
  const rows = buildRows(files, sort);
  const needing = attentionCount(files);

  return (
    <div style={S.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div style={S.shell}>

        {/* --- top bar, 44px --- */}
        <header style={S.topbar}>
          <span style={S.brand}>Keel</span>
          <span style={S.repo}>{props.cwd.split("/").slice(-2).join("/")}</span>
          <span style={{ flex: 1 }} />
          {(props.handoff.phase === "planning" || props.handoff.phase === "executing"
            || props.handoff.phase === "checking") && (
            <span style={S.agentPill}><span style={S.dot} />agent on task</span>
          )}
          {props.handoff.phase === "awaiting-approval" && (
            <span style={S.blocked}>a plan is waiting on you</span>
          )}
          {props.handoff.phase === "ready" && (
            <span style={S.blocked}>ready to review</span>
          )}
          <button style={S.ghost} onClick={props.onShowIntents}>intents</button>
          <button style={S.ghost} onClick={props.onShowTurn}>last turn</button>
          <button style={S.ghost} onClick={props.onClose}>close <span style={S.kbd}>esc</span></button>
        </header>

        <div style={S.grid}>

          {/* --- left: the tree as a worklist --- */}
          <aside style={S.tree}>
            <div style={S.treeHead}>
              <span style={{ ...TYPE.eyebrow, color: "rgba(253,253,252,.45)" }}>
                {sort === "attention" ? "BY ATTENTION" : sort === "alpha" ? "A–Z" : "HIERARCHY"}
              </span>
              <span style={{ flex: 1 }} />
              <button
                style={S.sortBtn}
                onClick={() => setSort((s) =>
                  s === "attention" ? "alpha" : s === "alpha" ? "hierarchy" : "attention")}
              >
                {sort === "attention" ? "A–Z" : sort === "alpha" ? "tree" : "attention"}
              </button>
            </div>

            <div style={S.treeRows}>
              {rows.length === 0 ? (
                <div style={S.treeEmpty}>nothing uncommitted</div>
              ) : rows.map((r) => (
                <div
                  key={`${r.kind}:${r.path}`}
                  style={{
                    ...S.treeRow,
                    paddingLeft: 12 + r.depth * 13,
                    background: props.open.includes(r.path) ? "rgba(82,81,253,.16)" : "transparent",
                    cursor: r.kind === "file" ? "pointer" : "default",
                  }}
                  onClick={() => r.kind === "file" && props.onOpenFile(r.path)}
                  title={r.path}
                >
                  <span style={{
                    ...TYPE.mono125, fontSize: 11.5,
                    fontWeight: r.kind === "dir" ? 500 : 400,
                    color: r.kind === "dir" ? "rgba(253,253,252,.55)" : TONE_FG[r.tone],
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {r.kind === "file" ? shortPath(r.name) : r.name}
                  </span>
                  <span style={{ flex: 1 }} />
                  {r.badge && (
                    <span style={{
                      fontFamily: FONT.product, fontSize: 9.5, flexShrink: 0,
                      color: r.tone === "changed" ? BRAND.brandText : "rgba(253,253,252,.58)",
                    }}>{r.badge}</span>
                  )}
                </div>
              ))}
            </div>

            <div style={S.treeNote}>
              {/*
                * Say where these rows came from.
                *
                * The previous wording claimed a ranking in every case. On a
                * clean repository nothing had been ranked at all -- every row
                * was borrowed from git history and shown as though it were the
                * turn's work, which is the one thing this column must not do.
                */}
              {needing > 0
                ? `${needing} of ${props.worklist?.total ?? 0} changed during this turn. Ranked by attention, not name.`
                : (props.worklist?.fromHistory ?? 0) > 0
                  ? "Nothing has changed yet. Showing your last commit, so this is history, not this turn's work."
                  : "Nothing has changed yet."}
            </div>
          </aside>

          {/* --- centre: file cards --- */}
          <main style={S.centre}>
            <div style={S.centreHead}>
              <span style={{ ...TYPE.eyebrow, color: INK.i5 }}>OPEN — MAXIMUM TWO</span>
              <span style={{ flex: 1 }} />
              <span style={{ ...TYPE.body115, color: INK.i5 }}>a third closes the oldest</span>
            </div>

            {props.open.length === 0 ? (
              <div style={S.centreEmpty}>
                <div style={{ ...TYPE.body135, color: INK.i2, marginBottom: 6 }}>
                  Pick a file from the worklist.
                </div>
                <div style={{ ...TYPE.body115, color: INK.i4, maxWidth: 460 }}>
                  A card shows what the file exports and what it is for — read from the
                  source, never written by hand, so it cannot go stale.
                </div>
              </div>
            ) : (
              props.open.map((path) => (
                <FileCard
                  key={path}
                  path={path}
                  tone={files.find((f) => f.path === path)?.tone ?? "normal"}
                  card={props.cards[path]}
                  onOpenInPane={() => props.onOpenInPane(path)}
                />
              ))
            )}
          </main>

          {/* --- right: the handoff rail --- */}
          <aside style={S.rail}>
            <KeelHandoff
              state={props.handoff}
              onStart={props.onStart}
              onApprove={props.onApprove}
              onReplan={props.onReplan}
              onStop={props.onStopHandoff}
              onReset={props.onResetHandoff}
              onShowTurn={props.onShowTurn}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * A path shortened so the filename always survives.
 *
 * The first attempt truncated the whole string from the left and produced
 * "ctions/VerificationWebsi…" -- a middle slice with neither the directory nor
 * the file. The name is the part you scan for, so it is kept whole and the
 * directory is what gives way.
 */
function shortPath(path: string): string {
  if (path.length <= 34) return path;
  const cut = path.lastIndexOf("/");
  if (cut === -1) return path.slice(0, 33) + "…";

  const file = path.slice(cut + 1);
  const dir = path.slice(0, cut);
  // A filename long enough to fill the row on its own gets the row.
  if (file.length >= 31) return "…/" + file;

  const room = 33 - file.length;
  const shortDir = dir.length <= room ? dir : "…" + dir.slice(-(room - 1));
  return `${shortDir}/${file}`;
}

/**
 * One file card.
 *
 * Contract on the left, invariants on the right — the handoff's two-column
 * grid. The invariants column has nothing to show until intents exist, and says
 * so in the place the clauses will occupy.
 */
function FileCard(props: {
  path: string;
  tone: Tone;
  card?: CardWire;
  onOpenInPane: () => void;
}) {
  const { card } = props;
  const dir = props.path.includes("/") ? props.path.slice(0, props.path.lastIndexOf("/") + 1) : "";
  const name = props.path.slice(dir.length);

  // Median surface is 2 entries and p90 is 14, but the tail reaches 107 --
  // measured on `core`. A cap keeps the long tail from burying the rail.
  const CAP = 12;
  const entries = card?.contract.entries ?? [];
  const shown = entries.slice(0, CAP);

  return (
    <article style={{ ...S.card, borderLeft: `2px solid ${TONE_EDGE[props.tone]}` }}>
      <div style={S.cardTitle}>
        <span style={{ ...TYPE.mono115, color: "rgba(253,253,252,.4)" }}>{dir}</span>
        <span style={{ ...TYPE.title17, color: INK.i1 }}>{name}</span>
        {props.tone === "changed" && <span style={S.stateChip}>changed this turn</span>}
        <span style={{ flex: 1 }} />
        <button style={S.sourceBtn} onClick={props.onOpenInPane}>source</button>
      </div>

      {!card ? (
        <div style={{ ...TYPE.body115, color: INK.i4 }}>reading…</div>
      ) : (
        <>
          <p style={S.purpose}>
            {card.purpose}
            {card.purposeInferred && (
              // The handoff's "no intent" state, which is the honest default
              // here rather than an edge case: nothing has written a purpose,
              // so this is read from the source and labelled as such.
              <span style={S.inferred}> · inferred from the source</span>
            )}
          </p>

          <div style={S.twoCol}>
            <div>
              <div style={S.colEyebrow}>CONTRACT — EXTRACTED, NOT WRITTEN</div>
              {card.contract.note ? (
                <div style={{ ...TYPE.body115, color: STATE.warn }}>{card.contract.note}</div>
              ) : entries.length === 0 ? (
                <div style={{ ...TYPE.body115, color: INK.i4 }}>nothing exported</div>
              ) : (
                <div style={S.sigList}>
                  {shown.map((e: ContractEntry) => (
                    <span key={`${e.kind}:${e.name}`} style={S.sig} title={e.summary ?? e.signature}>
                      {e.signature}
                    </span>
                  ))}
                  {entries.length > CAP && (
                    <span style={{ ...TYPE.body115, color: INK.i5 }}>
                      +{entries.length - CAP} more
                    </span>
                  )}
                </div>
              )}
            </div>

            <div>
              <div style={S.colEyebrow}>INVARIANTS</div>
              <div style={S.noIntent}>
                No intent covers this file, so nothing is checking it. Writing one is
                what turns this column from empty into the reason to trust a handoff.
              </div>
            </div>
          </div>
        </>
      )}
    </article>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "3vh 2vw", zIndex: 50, animation: "fove-fade-in 120ms ease-out",
  },
  shell: {
    width: "min(1320px, 100%)", height: "100%", minHeight: 0,
    display: "flex", flexDirection: "column",
    background: SURFACE.s0, border: `1px solid ${BORDER.b2}`, borderRadius: RADIUS.card,
    overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,.55)",
    animation: "fove-rise 160ms ease-out",
  },

  topbar: {
    display: "flex", alignItems: "center", gap: 14, height: 44, padding: "0 16px",
    background: SURFACE.s1, borderBottom: `1px solid ${BORDER.b2}`, flexShrink: 0,
  },
  brand: { fontFamily: FONT.product, fontSize: 12.5, fontWeight: 700, color: INK.i1, letterSpacing: "-0.01em" },
  repo: { fontFamily: FONT.mono, fontSize: 11.5, fontWeight: 500, color: "rgba(253,253,252,.6)" },
  agentPill: {
    display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px",
    borderRadius: RADIUS.pill, background: BRAND.wash, border: `1px solid ${BRAND.edge}`,
    fontFamily: FONT.product, fontSize: 11.5, fontWeight: 500, color: INK.i1,
  },
  dot: {
    width: 6, height: 6, borderRadius: "50%", background: BRAND.brand,
    animation: "fove-pulse 1.6s ease-in-out infinite",
  },
  blocked: { fontFamily: FONT.product, fontSize: 11.5, color: STATE.warn },
  ghost: {
    padding: "4px 10px", borderRadius: RADIUS.chip, border: `1px solid ${BORDER.b2}`,
    background: "transparent", color: INK.i3, ...TYPE.body115, cursor: "pointer",
  },
  kbd: { color: INK.i5, marginLeft: 5, fontSize: 10 },

  grid: {
    flex: 1, display: "grid", gridTemplateColumns: "250px minmax(0,1fr) 316px",
    minHeight: 0,
  },

  tree: {
    borderRight: `1px solid ${BORDER.b2}`, padding: "13px 0",
    display: "flex", flexDirection: "column", minHeight: 0,
  },
  treeHead: { display: "flex", alignItems: "center", padding: "0 12px 10px" },
  sortBtn: {
    background: "transparent", border: "none", color: "rgba(253,253,252,.58)",
    fontFamily: FONT.product, fontSize: 10.5, cursor: "pointer", padding: 0,
  },
  treeRows: { flex: 1, overflowY: "auto", minHeight: 0 },
  treeRow: {
    display: "flex", alignItems: "center", gap: 8, height: 27,
    paddingRight: 10,
  },
  treeEmpty: { padding: "12px", ...TYPE.body115, color: INK.i5 },
  treeNote: {
    margin: "10px 12px 0", padding: "10px 11px", borderRadius: 7,
    background: "rgba(210,204,192,.05)", border: "1px solid rgba(210,204,192,.1)",
    fontFamily: FONT.product, fontSize: 11, lineHeight: 1.5, color: "rgba(253,253,252,.58)",
  },

  centre: {
    padding: "15px 20px", display: "flex", flexDirection: "column", gap: 12,
    overflowY: "auto", minHeight: 0,
  },
  centreHead: { display: "flex", alignItems: "center" },
  centreEmpty: {
    flex: 1, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", textAlign: "center",
  },

  card: {
    borderRadius: 10, background: SURFACE.s1, border: `1px solid rgba(210,204,192,.12)`,
    padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14,
  },
  cardTitle: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  stateChip: {
    padding: "2px 8px", borderRadius: RADIUS.pill, background: "rgba(255,143,46,.12)",
    fontFamily: FONT.product, fontSize: 10.5, color: STATE.warn,
  },
  sourceBtn: {
    background: "transparent", border: "none", color: BRAND.brandText,
    fontFamily: FONT.product, fontSize: 11, cursor: "pointer", padding: 0,
  },
  purpose: {
    ...TYPE.body135, color: INK.i2, margin: 0, maxWidth: 620, textWrap: "pretty",
  },
  inferred: { color: INK.i5, fontSize: 11.5 },

  twoCol: { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 18 },
  colEyebrow: {
    fontFamily: FONT.mono, fontSize: 9.5, fontWeight: 500, letterSpacing: "0.08em",
    color: INK.i5, marginBottom: 8, textTransform: "uppercase",
  },
  sigList: { display: "flex", flexDirection: "column", gap: 6 },
  sig: {
    fontFamily: FONT.mono, fontSize: 11.5, lineHeight: 1.5,
    color: "rgba(253,253,252,.75)", overflowWrap: "anywhere",
  },
  noIntent: {
    ...TYPE.body115, color: INK.i4, padding: "9px 11px", borderRadius: 7,
    border: `1px dashed ${BORDER.b1}`,
  },

  rail: {
    borderLeft: `1px solid ${BORDER.b1}`, background: SURFACE.s2,
    padding: "15px 16px", display: "flex", flexDirection: "column",
    // The rail holds risks and checks, as long as the agent made them.
    // Without a scroll of its own the tail is simply unreachable.
    minHeight: 0, overflowY: "auto",
  },
  railGap: {
    ...TYPE.body115, color: INK.i4, padding: "10px 11px", borderRadius: 7,
    border: `1px dashed ${BORDER.b1}`,
  },
  blockBox: {
    padding: "12px 13px", borderRadius: 8,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
  },
  nextBox: {
    padding: "12px 13px", borderRadius: 8,
    background: SURFACE.s1, border: `1px solid ${BORDER.b1}`,
  },
};
