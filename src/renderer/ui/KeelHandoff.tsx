/**
 * The handoff rail: hand over a ticket, watch the loop, review the result.
 *
 * This is the rail block the `4a` spec calls task / plan / blocking-decision,
 * made real. Until now it explained why it was empty -- nothing published a
 * plan before starting, so there was nothing to hold an agent to. Now there is.
 *
 * The screen's job is to make one thing obvious at every moment: **what is
 * being waited on, and by whom.** Planning waits on nothing. The gate waits on
 * you. Ready waits on you. Everything else is the loop working.
 *
 * The gate is the design. An approved plan is approved *as written*; a revised
 * one comes back for approval, and the rail says the plan changed rather than
 * quietly presenting a new one as if it were the old.
 */

import { useEffect, useState } from "react";
import { SURFACE, BORDER, INK, BRAND, STATE, FONT, TYPE, RADIUS, SHADOW } from "./keel-tokens.js";
import { planProgress, describeProgress } from "../../shared/progress.js";
import {
  describe as describePhase, isRunning, needsYou, openQuestions,
  type HandoffState,
} from "../../shared/handoff.js";

/** Colour for the phase pill: brand while working, saffron when waiting on you. */
function phaseTone(state: HandoffState): { fg: string; bg: string; edge: string } {
  if (needsYou(state)) {
    return { fg: STATE.warn, bg: STATE.warnWash, edge: STATE.warnEdge };
  }
  if (state.phase === "stopped") {
    return { fg: INK.i4, bg: SURFACE.s2, edge: BORDER.b1 };
  }
  return { fg: INK.i1, bg: BRAND.wash, edge: BRAND.edge };
}

/**
 * A clock that ticks while a phase runs.
 *
 * Deliberately its own component so the second-by-second re-render is confined
 * to this one span rather than repainting the whole rail.
 */
function Elapsed(props: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!props.since) return null;
  const secs = Math.max(0, Math.floor((now - props.since) / 1000));
  const mins = Math.floor(secs / 60);
  const text = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;

  return (
    <span style={{
      fontFamily: FONT.mono, fontSize: 11, color: INK.i4,
      fontVariantNumeric: "tabular-nums",
    }}>
      {text}
    </span>
  );
}

export function KeelHandoff(props: {
  state: HandoffState;
  /** Paths the tree says have moved during the running phase. */
  changedSoFar?: string[];
  /** Budget the next handoff runs under. */
  onStart: (ticket: string, budgetUSD: number) => void;
  onApprove: () => void;
  onReplan: (note: string) => void;
  onStop: () => void;
  onReset: () => void;
  onShowTurn: () => void;
}) {
  const { state } = props;
  const [ticket, setTicket] = useState("");
  const [budget, setBudget] = useState(5);
  const [note, setNote] = useState("");
  const [revising, setRevising] = useState(false);

  const tone = phaseTone(state);
  const questions = openQuestions(state);
  const progress = planProgress(state.plan, props.changedSoFar ?? []);
  const progressLine = describeProgress(progress);

  return (
    <div style={S.wrap}>
      {/* --- where the loop is --- */}
      <div style={{ ...S.phasePill, color: tone.fg, background: tone.bg, borderColor: tone.edge }}>
        {isRunning(state) && <span style={S.dot} />}
        {describePhase(state)}
      </div>

      {state.phase === "idle" || state.phase === "stopped" ? (
        <>
          {state.phase === "stopped" && (
            <div style={S.stopped}>
              {state.stoppedReason}
              {state.costUSD > 0 && ` · $${state.costUSD.toFixed(2)} spent`}
            </div>
          )}

          <div style={{ ...TYPE.eyebrow, color: INK.i5 }}>HAND OVER A TICKET</div>
          <textarea
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()} // app shortcuts must not fire here
            placeholder="What needs doing? Be specific about the outcome, not the steps."
            style={S.ticketBox}
          />
          <div style={S.budgetRow}>
            {/*
              * A ceiling on how much work a runaway task may do, not a bill.
              * This machine authenticates by OAuth with no API key, so the
              * figure is subscription usage rather than money -- the CLI
              * reports it in dollars because that is what tokens cost at API
              * rates, and calling it a charge here would be a lie.
              */}
            <span style={{ ...TYPE.body115, color: INK.i4 }}>stop after</span>
            <input
              type="number" min={1} max={50} step={1} value={budget}
              onChange={(e) => setBudget(Math.max(1, Number(e.target.value) || 1))}
              onKeyDown={(e) => e.stopPropagation()}
              style={S.budgetInput}
            />
            <span style={{ ...TYPE.body115, color: INK.i4 }}>units of usage</span>
            <span style={{ flex: 1 }} />
            <button
              style={{ ...S.primary, opacity: ticket.trim() ? 1 : 0.4 }}
              disabled={!ticket.trim()}
              onClick={() => props.onStart(ticket.trim(), budget)}
            >
              Plan it
            </button>
          </div>
          <div style={{ ...TYPE.body115, color: INK.i5 }}>
            Planning cannot edit anything. You see the plan before it runs.
            <br />
            Runs on your Claude subscription — the cap is a ceiling on how much
            work a runaway task may do, not a bill.
          </div>
        </>
      ) : (
        <>
          {/* --- the ticket --- */}
          <div>
            <div style={{ ...TYPE.eyebrow, color: INK.i5, marginBottom: 7 }}>TICKET</div>
            <div style={{ ...TYPE.body125, color: INK.i2 }}>{state.ticket}</div>
          </div>

          {/* --- the plan --- */}
          {state.plan && (
            <div>
              <div style={S.planHead}>
                <span style={{ ...TYPE.eyebrow, color: INK.i5 }}>
                  PLAN — WRITTEN BEFORE IT STARTED
                </span>
                {state.planRevision > 1 && (
                  <span style={S.revChip}>revision {state.planRevision}</span>
                )}
              </div>
              <div style={{ ...TYPE.body125, color: INK.i2, marginBottom: 10 }}>
                {state.plan.summary}
              </div>
              <div style={S.steps}>
                {progress.steps.map((s) => (
                  <div key={s.n} style={S.step}>
                    {/*
                      * The marker is evidence, not the agent's opinion: a step
                      * is ticked when the files it said it would touch have
                      * actually moved. A step that named no files gets a
                      * hollow marker, because the tree cannot say either way
                      * and pretending otherwise is the failure mode here.
                      */}
                    <span
                      style={{
                        ...S.stepNum,
                        color: s.state === "done" ? STATE.good
                          : s.state === "unknown" ? INK.i5 : INK.i4,
                      }}
                      title={
                        s.state === "done" ? `changed: ${s.touched.join(", ")}`
                          : s.state === "pending" ? `waiting on: ${s.awaiting.join(", ")}`
                            : "this step named no files, so its status cannot be checked"
                      }
                    >
                      {s.state === "done" ? "✓" : s.n}
                    </span>
                    <span style={{
                      ...TYPE.body115,
                      color: s.state === "done" ? INK.i4 : INK.i3,
                    }}>
                      {s.action}
                    </span>
                  </div>
                ))}
              </div>
              {progressLine && (
                <div style={{ ...TYPE.body115, color: INK.i5, marginTop: 8 }}>
                  {progressLine}
                </div>
              )}
              {progress.unexpected.length > 0 && (
                <div style={S.unexpected}>
                  {/*
                    * The plan was approved on the strength of what it said it
                    * would do, so work outside it is worth seeing while it is
                    * happening rather than at review.
                    */}
                  <span style={{ ...TYPE.eyebrow, color: STATE.warn }}>
                    NO STEP CLAIMED THESE
                  </span>
                  <div style={{ ...TYPE.mono105, color: INK.i4, marginTop: 5 }}>
                    {progress.unexpected.slice(0, 6).join(", ")}
                    {progress.unexpected.length > 6
                      && ` and ${progress.unexpected.length - 6} more`}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* --- what only you can decide --- */}
          {questions.length > 0 && (
            <div style={S.questions}>
              <div style={{ ...TYPE.eyebrow, color: STATE.warn, marginBottom: 8 }}>
                ONLY YOU CAN DECIDE
              </div>
              {questions.map((q, i) => (
                <div key={i} style={{ ...TYPE.body115, color: INK.i2, marginBottom: 5 }}>
                  {q}
                </div>
              ))}
            </div>
          )}

          {/* --- the gate --- */}
          {state.phase === "awaiting-approval" && (
            <div style={{ ...S.gate, order: -1 }}>
              {revising ? (
                <>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="What should it do differently?"
                    style={{ ...S.ticketBox, minHeight: 56 }}
                  />
                  <div style={S.gateRow}>
                    <button style={S.ghost} onClick={() => setRevising(false)}>cancel</button>
                    <span style={{ flex: 1 }} />
                    <button
                      style={S.primary}
                      onClick={() => { props.onReplan(note.trim()); setNote(""); setRevising(false); }}
                    >
                      Replan
                    </button>
                  </div>
                </>
              ) : (
                <div style={S.gateRow}>
                  <button style={S.primary} onClick={props.onApprove}>Approve and run</button>
                  <button style={S.ghost} onClick={() => setRevising(true)}>revise</button>
                  <span style={{ flex: 1 }} />
                  <button style={S.ghost} onClick={props.onStop}>discard</button>
                </div>
              )}
            </div>
          )}

          {/* --- checks, once they exist --- */}
          {state.checks.length > 0 && (
            <div>
              <div style={{ ...TYPE.eyebrow, color: INK.i5, marginBottom: 8 }}>
                CHECKED AFTERWARDS
              </div>
              {state.checks.map((c, i) => (
                <div key={i} style={S.check}>
                  <span style={{
                    ...TYPE.body115,
                    color: c.passed ? STATE.good : STATE.warn,
                    width: 34, flexShrink: 0,
                  }}>
                    {c.passed ? "pass" : "fail"}
                  </span>
                  <span style={{ ...TYPE.body115, color: INK.i3, flex: 1 }}>
                    {c.label}
                  </span>
                  {/*
                    * A mechanism ran and gave a verdict; a review is a
                    * judgment. Rendering them the same way is how "no agent
                    * objected" quietly becomes "a test passed".
                    */}
                  <span style={{ ...TYPE.mono105, color: INK.i5, flexShrink: 0 }}>
                    {c.kind === "mechanism" ? "checked" : "judged"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* --- ready --- */}
          {state.phase === "ready" && (
            <div style={{ ...S.ready, order: -1 }}>
              <div style={{ ...TYPE.body125, color: INK.i2, marginBottom: 10 }}>
                The work is done and checked. Nothing has been committed — reviewing
                and merging are yours.
              </div>
              <div style={S.gateRow}>
                <button style={S.primary} onClick={props.onShowTurn}>Review what changed</button>
                <span style={{ flex: 1 }} />
                <button style={S.ghost} onClick={props.onReset}>new ticket</button>
              </div>
            </div>
          )}

          {isRunning(state) && (
            <div style={S.gateRow}>
              {/*
                * Elapsed time, not just usage.
                *
                * Usage is reported by the CLI when a phase *finishes*, so it
                * reads 0.00 for the whole of a run -- which makes a working
                * agent and a hung one look identical. Planning a task that
                * has to fetch a ticket and read the codebase legitimately
                * takes minutes, and the only honest way to say "still
                * working" is a clock that moves.
                */}
              <Elapsed since={state.startedAt} />
              <span style={{ ...TYPE.body115, color: INK.i5, flex: 1 }}>
                {state.costUSD > 0
                  ? `${state.costUSD.toFixed(2)} of ${state.budgetUSD.toFixed(2)} used`
                  : `usage is counted when this phase finishes`}
              </span>
              <button style={S.ghost} onClick={props.onStop}>stop</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 14, minHeight: 0, overflowY: "auto" },

  phasePill: {
    display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start",
    padding: "5px 11px", borderRadius: RADIUS.pill, border: "1px solid",
    fontFamily: FONT.product, fontSize: 11.5, fontWeight: 500,
  },
  dot: {
    width: 6, height: 6, borderRadius: "50%", background: BRAND.brand,
    animation: "fove-pulse 1.6s ease-in-out infinite",
  },

  ticketBox: {
    width: "100%", minHeight: 84, resize: "vertical", boxSizing: "border-box",
    background: SURFACE.s0, border: `1px solid ${BORDER.b2}`, borderRadius: RADIUS.box,
    color: INK.i1, fontFamily: FONT.product, fontSize: 12.5, lineHeight: 1.55,
    padding: "9px 11px", outline: "none",
  },
  budgetRow: { display: "flex", alignItems: "center", gap: 8 },
  budgetInput: {
    width: 52, background: SURFACE.s0, border: `1px solid ${BORDER.b2}`,
    borderRadius: RADIUS.chip, color: INK.i1, fontFamily: FONT.mono, fontSize: 11.5,
    padding: "3px 7px", outline: "none",
  },

  planHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  revChip: {
    padding: "1px 7px", borderRadius: RADIUS.pill, background: STATE.warnWash,
    border: `1px solid ${STATE.warnEdge}`, color: STATE.warn,
    fontFamily: FONT.product, fontSize: 10,
  },
  steps: { display: "flex", flexDirection: "column", gap: 7 },
  step: { display: "flex", gap: 9, alignItems: "baseline" },
  stepNum: {
    fontFamily: FONT.mono, fontSize: 10.5, color: INK.i5,
    width: 16, flexShrink: 0, textAlign: "center",
    // A tick and a digit must occupy the same box or the list jitters as
    // steps complete.
    display: "inline-block", lineHeight: "16px",
  },
  unexpected: {
    marginTop: 10, padding: "8px 10px", borderRadius: 7,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
  },

  questions: {
    padding: "11px 13px", borderRadius: RADIUS.box,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
    // Risks run long -- five paragraphs is normal. Capped so they cannot push
    // the gate and the ready actions off the bottom of the rail.
    maxHeight: 260, overflowY: "auto",
  },

  gate: {
    padding: "12px 13px", borderRadius: RADIUS.box,
    background: BRAND.wash, border: `1px solid ${BRAND.brand}`,
    display: "flex", flexDirection: "column", gap: 9,
  },
  gateRow: { display: "flex", alignItems: "center", gap: 8 },

  check: { display: "flex", alignItems: "baseline", gap: 9, marginBottom: 5 },

  ready: {
    padding: "12px 13px", borderRadius: RADIUS.box,
    background: STATE.goodWash, border: `1px solid ${STATE.goodEdge}`,
  },
  stopped: {
    padding: "9px 11px", borderRadius: RADIUS.box, background: SURFACE.s2,
    border: `1px solid ${BORDER.b1}`, fontFamily: FONT.product, fontSize: 11.5,
    color: INK.i4,
  },

  primary: {
    height: 32, padding: "0 15px", border: "none", borderRadius: 8,
    background: BRAND.brand, color: INK.i1,
    fontFamily: FONT.product, fontSize: 12, fontWeight: 500, cursor: "pointer",
    boxShadow: SHADOW.brand,
  },
  ghost: {
    height: 32, padding: "0 12px", borderRadius: 8,
    border: `1px solid ${BORDER.b2}`, background: "transparent", color: INK.i3,
    fontFamily: FONT.product, fontSize: 12, cursor: "pointer",
  },
};
