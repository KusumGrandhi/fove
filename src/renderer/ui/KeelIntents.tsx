/**
 * Keel `2d` — the intent editor.
 *
 * The human-owned spec. Everything else in Keel is generated; this is the one
 * surface you write, and it is what turns the invariants column on a file card
 * from an explanation of its own emptiness into a reason to trust a handoff.
 *
 * Two rules from the handoff, load-bearing:
 *
 *   - **The agent may propose, never edit.** A proposal arrives with the
 *     evidence it cites, and Adopt is a human action. Nothing an agent says
 *     writes to this file.
 *   - **Each clause should be checkable, and the mechanism is shown next to
 *     it.** "Should", not "must" — a prose-only clause is the common and
 *     expected case, and requiring a check before a rule may exist means the
 *     rules that matter most never get written.
 *
 * Where this departs from the handoff: it shows a **candidates** section, for
 * rules the repository already documents in `AGENTS.md` but fove has not
 * adopted. `core`'s file yields 29 of them. Starting from what a team already
 * agreed beats starting from a blank page, and fove only ever reads that file.
 */

import { useState } from "react";
import { SURFACE, BORDER, INK, BRAND, STATE, FONT, TYPE, RADIUS } from "./keel-tokens.js";
import { sortClauses, type Clause, type ClauseState, type Intent } from "../../shared/intents.js";

export interface IntentsWire {
  identity: string | null;
  dir: string | null;
  intents: Intent[];
  candidates: { name: string; text: string; from: string }[];
}

const STATE_COLOR: Record<ClauseState, string> = {
  proven: STATE.good,
  drifted: STATE.warn,
  contested: STATE.warn,
  unverifiable: INK.i5,
};

const STATE_WORD: Record<ClauseState, string> = {
  proven: "proven",
  drifted: "drifted",
  contested: "contested",
  unverifiable: "unchecked",
};

export function KeelIntents(props: {
  cwd: string;
  data: IntentsWire | null;
  /** Mechanism results from this session, keyed by clause id. */
  results: Record<string, { passed: boolean; output: string } | undefined>;
  onRun: (clauseKey: string, command: string) => void;
  onAdopt: (candidate: { name: string; text: string; from: string }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const { data } = props;
  const [showCandidates, setShowCandidates] = useState(true);

  const drifted = (data?.intents ?? [])
    .flatMap((i) => i.clauses)
    .filter((c) => c.state === "drifted").length;

  return (
    <div style={S.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div style={S.card}>

        <header style={S.topbar}>
          <span style={S.path}>
            {data?.identity ? `~/.fove/intents/${data.identity}` : "no repository"}
          </span>
          <span style={S.owned}>owned by you · agent may propose, never edit</span>
          <span style={{ flex: 1 }} />
          {drifted > 0 && <span style={S.driftPill}>{drifted} drifted</span>}
          <button style={S.ghost} onClick={props.onBack}>back</button>
          <button style={S.ghost} onClick={props.onClose}>close <span style={S.kbd}>esc</span></button>
        </header>

        <div style={S.body}>
          {!data?.identity ? (
            <div style={S.note}>
              This workspace is not a git repository, so there is nowhere stable to
              keep intents.
            </div>
          ) : (
            <>
              {/*
                * Where the file lives, stated up front. It is the question
                * everyone asks first, and the answer is a deliberate
                * constraint rather than an implementation detail.
                */}
              <div style={S.note}>
                Intents live outside the repository, in your home directory. They are
                yours, not the team's — nothing fove writes ever shows up in{" "}
                <span style={{ fontFamily: FONT.mono }}>git status</span>.
              </div>

              {data.intents.length === 0 ? (
                <div style={S.empty}>
                  <div style={{ ...TYPE.title17, color: INK.i1, marginBottom: 8 }}>
                    No intents yet.
                  </div>
                  <div style={{ ...TYPE.body125, color: INK.i3, maxWidth: "62ch" }}>
                    An intent is a rule about this codebase that must stay true — the
                    thing you say in review, written where an agent can read it.
                    {data.candidates.length > 0 && (
                      <> This repository already documents{" "}
                        <b style={{ color: INK.i1 }}>{data.candidates.length}</b> of them.</>
                    )}
                  </div>
                </div>
              ) : (
                data.intents.map((intent) => (
                  <IntentBlock
                    key={intent.id}
                    intent={intent}
                    results={props.results}
                    onRun={props.onRun}
                  />
                ))
              )}

              {/* --- candidates from the repo's own conventions --- */}
              {data.candidates.length > 0 && (
                <section>
                  <div
                    style={S.candHead}
                    onClick={() => setShowCandidates((v) => !v)}
                  >
                    <span style={{ ...TYPE.eyebrow, color: BRAND.brandText }}>
                      ALREADY WRITTEN IN {data.candidates[0]!.from.toUpperCase()}
                    </span>
                    <span style={S.candCount}>{data.candidates.length}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ ...TYPE.body115, color: INK.i5 }}>
                      {showCandidates ? "hide" : "show"}
                    </span>
                  </div>

                  {showCandidates && (
                    <div style={S.candList}>
                      <div style={{ ...TYPE.body115, color: INK.i4, marginBottom: 4 }}>
                        Rules this repository already states. fove reads that file and
                        never writes to it — adopting one copies it here.
                      </div>
                      {data.candidates.slice(0, 12).map((c) => (
                        <div key={c.text} style={S.cand}>
                          <span style={{ ...TYPE.body115, color: INK.i2, flex: 1 }}>{c.text}</span>
                          <button style={S.adopt} onClick={() => props.onAdopt(c)}>adopt</button>
                        </div>
                      ))}
                      {data.candidates.length > 12 && (
                        <div style={{ ...TYPE.body115, color: INK.i5 }}>
                          +{data.candidates.length - 12} more
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One intent: its headline, then its clauses worst-first. */
function IntentBlock(props: {
  intent: Intent;
  results: Record<string, { passed: boolean; output: string } | undefined>;
  onRun: (key: string, command: string) => void;
}) {
  const { intent } = props;
  return (
    <section style={{ marginBottom: 6 }}>
      <h2 style={S.headline}>{intent.headline}</h2>
      {intent.scope && (
        <div style={{ ...TYPE.mono105, color: INK.i5, marginBottom: 10 }}>
          scope: {intent.scope}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sortClauses(intent.clauses).map((c) => (
          <ClauseRow
            key={`${intent.id}:${c.num}`}
            clause={c}
            result={props.results[`${intent.id}:${c.num}`]}
            onRun={() => c.mechanism && props.onRun(`${intent.id}:${c.num}`, c.mechanism)}
          />
        ))}
      </div>
    </section>
  );
}

function ClauseRow(props: {
  clause: Clause;
  result?: { passed: boolean; output: string };
  onRun: () => void;
}) {
  const { clause, result } = props;
  // A result from *this session* is the only thing that earns "proven".
  const state: ClauseState = result ? (result.passed ? "proven" : "drifted") : clause.state;

  return (
    <div style={{ ...S.clause, borderLeft: `2px solid ${STATE_COLOR[state]}` }}>
      <div style={S.clauseHead}>
        <span style={{ ...TYPE.mono105, color: INK.i4 }}>{clause.num}</span>
        <span style={{ ...TYPE.body125, fontWeight: 500, color: INK.i1 }}>{clause.name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: FONT.product, fontSize: 10, color: STATE_COLOR[state] }}>
          {STATE_WORD[state]}
        </span>
      </div>

      <div style={{ ...TYPE.body125, color: INK.i3, textWrap: "pretty" }}>{clause.text}</div>

      {clause.mechanism ? (
        <div style={S.mech}>
          <span style={{ ...TYPE.mono105, color: INK.i4, flex: 1, overflowWrap: "anywhere" }}>
            {clause.mechanism}
          </span>
          <button style={S.runBtn} onClick={props.onRun}>run</button>
        </div>
      ) : (
        // Not a failure. Most clauses are prose, and the ones that matter most
        // often cannot be checked at all -- so this states the consequence
        // rather than nagging.
        <div style={{ ...TYPE.body115, color: INK.i5 }}>
          No mechanism, so nothing checks this automatically. An agent can still
          read it.
        </div>
      )}

      {result && !result.passed && (
        <pre style={S.output}>{result.output.slice(0, 600)}</pre>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    paddingTop: "5vh", zIndex: 50, animation: "fove-fade-in 120ms ease-out",
  },
  card: {
    width: "min(872px, 94%)", maxHeight: "88vh", display: "flex", flexDirection: "column",
    background: SURFACE.s0, border: `1px solid ${BORDER.b2}`, borderRadius: RADIUS.card,
    overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,.55)",
    animation: "fove-rise 160ms ease-out",
  },

  topbar: {
    display: "flex", alignItems: "center", gap: 12, height: 44, padding: "0 16px",
    background: SURFACE.s1, borderBottom: `1px solid ${BORDER.b2}`, flexShrink: 0,
  },
  path: { fontFamily: FONT.mono, fontSize: 12, fontWeight: 500, color: INK.i1 },
  owned: { ...TYPE.body115, color: INK.i4 },
  driftPill: {
    padding: "3px 9px", borderRadius: RADIUS.pill,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
    fontFamily: FONT.product, fontSize: 10.5, color: STATE.warn,
  },
  ghost: {
    padding: "4px 10px", borderRadius: RADIUS.chip, border: `1px solid ${BORDER.b2}`,
    background: "transparent", color: INK.i3, ...TYPE.body115, cursor: "pointer",
  },
  kbd: { color: INK.i5, marginLeft: 5, fontSize: 10 },

  body: {
    // flex:1 + minHeight:0 are what make this actually scroll: the card is a
    // flex column with overflow:hidden, so without them the body grows past
    // the card and the overflow is clipped away rather than scrolled to.
    flex: 1, minHeight: 0,
    overflowY: "auto", padding: "18px 20px 20px",
    display: "flex", flexDirection: "column", gap: 16,
  },
  note: {
    ...TYPE.body115, color: INK.i4, padding: "10px 12px", borderRadius: RADIUS.box,
    background: SURFACE.s1, border: `1px solid ${BORDER.b1}`,
  },
  empty: { padding: "20px 0" },

  headline: { ...TYPE.title17, lineHeight: 1.35, color: INK.i1, margin: "0 0 10px", maxWidth: "62ch" },

  clause: {
    borderRadius: RADIUS.box, background: SURFACE.s1, border: `1px solid ${BORDER.b1}`,
    padding: "12px 14px", display: "flex", flexDirection: "column", gap: 7,
  },
  clauseHead: { display: "flex", alignItems: "center", gap: 9 },
  mech: {
    display: "flex", alignItems: "center", gap: 10, padding: "7px 9px",
    borderRadius: 7, background: SURFACE.s2, border: `1px solid ${BORDER.b1}`,
  },
  runBtn: {
    padding: "2px 10px", borderRadius: RADIUS.chip, border: `1px solid ${BRAND.edge}`,
    background: BRAND.wash, color: BRAND.brandText,
    fontFamily: FONT.product, fontSize: 10.5, cursor: "pointer", flexShrink: 0,
  },
  output: {
    margin: 0, padding: "8px 10px", borderRadius: 7,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
    fontFamily: FONT.mono, fontSize: 10.5, lineHeight: 1.5, color: INK.i2,
    whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto",
  },

  candHead: {
    display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
    padding: "6px 0",
  },
  candCount: {
    fontFamily: FONT.product, fontSize: 10, color: BRAND.brandText,
    background: BRAND.wash, borderRadius: RADIUS.pill, padding: "1px 7px",
  },
  candList: {
    display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px",
    borderRadius: RADIUS.box, background: "rgba(82,81,253,.1)",
    border: `1px solid ${BRAND.brand}`,
  },
  cand: { display: "flex", alignItems: "center", gap: 10 },
  adopt: {
    padding: "3px 12px", borderRadius: RADIUS.chip, border: "none",
    background: BRAND.brand, color: INK.i1,
    fontFamily: FONT.product, fontSize: 10.5, fontWeight: 500, cursor: "pointer",
    flexShrink: 0,
  },
};
