/**
 * The debugger pane.
 *
 * Python only this round -- `core` is Flask, which is the code actually stepped
 * through here.
 *
 * The pane leads with the two things that decide whether a session can start at
 * all: which launch config, and which interpreter. On this machine that second
 * one is not a detail -- the Python on PATH is conda's *base* install and does
 * not have Flask, so defaulting to it would fail at the first import with a
 * message blaming the code. `debugpy` availability is shown per interpreter for
 * the same reason: it is a precondition, and learning it from a traceback after
 * launching is a poor substitute for being told.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../ui/Chrome.js";

interface LaunchConfig { name: string; type: string; request: string; module?: string; program?: string }
interface Interpreter { path: string; label: string; version?: string; hasDebugpy?: boolean }
interface StackFrame { id: number; name: string; path?: string; line: number; column: number }
interface Scope { name: string; variablesReference: number; expensive: boolean }
interface Variable { name: string; value: string; type?: string; variablesReference: number }
interface Status { state: "starting" | "running" | "paused" | "terminated"; reason?: string; error?: string }

export function DebuggerPane(props: {
  cwd: string;
  /** Breakpoints set in the editor, so both panes agree on them. */
  breakpoints?: { path: string; line: number }[];
  onOpen?: (path: string, line?: number) => void;
}) {
  const [configs, setConfigs] = useState<LaunchConfig[]>([]);
  const [interpreters, setInterpreters] = useState<Interpreter[]>([]);
  const [configName, setConfigName] = useState("");
  const [python, setPython] = useState("");
  const [status, setStatus] = useState<Status>({ state: "terminated" });
  const [frames, setFrames] = useState<StackFrame[]>([]);
  const [frameId, setFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [vars, setVars] = useState<Record<number, Variable[]>>({});
  const [output, setOutput] = useState<{ text: string; category: string }[]>([]);
  const [expr, setExpr] = useState("");
  const [watch, setWatch] = useState<{ expr: string; value: string; error?: string }[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const [c, i] = await Promise.all([
        window.th.dbgConfigs(props.cwd) as Promise<LaunchConfig[]>,
        window.th.dbgInterpreters(props.cwd) as Promise<Interpreter[]>,
      ]);
      setConfigs(c);
      setInterpreters(i);
      if (c[0]) setConfigName(c[0].name);
      /*
       * A remembered choice wins; otherwise prefer one that can actually run
       * the debugger. `findInterpreters` puts a chosen interpreter first, so
       * `i[0]` is that choice when there is one -- and overriding it with a
       * debugpy guess would quietly undo what the user picked.
       */
      const remembered = i[0]?.label === "chosen for this project" ? i[0] : null;
      setPython((remembered ?? i.find((x) => x.hasDebugpy) ?? i[0])?.path ?? "");
    })();
  }, [props.cwd]);

  useEffect(() => {
    const offStatus = window.th.onDbgStatus((s) => setStatus(s as Status));
    const offOutput = window.th.onDbgOutput((text, category) =>
      // Bounded: a chatty program should not grow this without limit.
      setOutput((prev) => [...prev, { text, category }].slice(-500)),
    );
    return () => { offStatus(); offOutput(); };
  }, []);

  /** On every stop, refresh the stack -- it is the anchor for everything else. */
  useEffect(() => {
    if (status.state !== "paused") {
      setFrames([]);
      setFrameId(null);
      return;
    }
    void (async () => {
      const f = (await window.th.dbgStack()) as StackFrame[];
      setFrames(f);
      setFrameId(f[0]?.id ?? null);
    })();
  }, [status.state, status.reason]);

  // Scopes follow the selected frame; variables follow the scopes.
  useEffect(() => {
    if (frameId === null) { setScopes([]); setVars({}); return; }
    void (async () => {
      const s = (await window.th.dbgScopes(frameId)) as Scope[];
      setScopes(s);
      const loaded: Record<number, Variable[]> = {};
      // Skip expensive scopes (globals in a large module): the adapter warns
      // they are slow, and fetching one on every step makes stepping crawl.
      for (const scope of s.filter((x) => !x.expensive)) {
        loaded[scope.variablesReference] =
          (await window.th.dbgVariables(scope.variablesReference)) as Variable[];
      }
      setVars(loaded);
    })();
  }, [frameId]);

  const start = useCallback(async () => {
    setError("");
    setOutput([]);
    const config = configs.find((c) => c.name === configName);
    if (!config) { setError("no launch configuration selected"); return; }
    const r = (await window.th.dbgStart({
      config, cwd: props.cwd, python,
      breakpoints: props.breakpoints ?? [],
    })) as { ok: boolean; error?: string };
    if (!r.ok) setError(r.error ?? "could not start");
  }, [configs, configName, python, props.cwd, props.breakpoints]);

  const evaluate = useCallback(async () => {
    if (!expr.trim()) return;
    const r = (await window.th.dbgEvaluate(expr, frameId ?? undefined)) as
      { value: string; error?: string };
    setWatch((prev) => [{ expr, ...r }, ...prev].slice(0, 20));
    setExpr("");
  }, [expr, frameId]);

  const running = status.state === "running" || status.state === "starting";
  const paused = status.state === "paused";
  const chosen = interpreters.find((i) => i.path === python);

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <select value={configName} onChange={(e) => setConfigName(e.target.value)}
          style={S.select} disabled={running || paused}>
          {configs.length === 0 && <option value="">no launch.json</option>}
          {configs.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        {/*
          * Choosing here is choosing for the project, not for this run.
          *
          * The language server needs the same answer -- it is what lets
          * go-to-definition follow a third-party import instead of silently
          * resolving to nothing -- so the choice is remembered and shared
          * rather than living and dying with this pane.
          */}
        <select value={python} onChange={(e) => {
          setPython(e.target.value);
          void window.th.dbgChooseInterpreter(props.cwd, e.target.value || null);
        }}
          style={S.select} disabled={running || paused}>
          {interpreters.map((i) => (
            <option key={i.path} value={i.path}>
              {i.label}{i.version ? ` · ${i.version}` : ""}{i.hasDebugpy === false ? " · no debugpy" : ""}
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {!running && !paused ? (
          <button style={S.go} onClick={() => void start()} disabled={configs.length === 0}>▶ start</button>
        ) : (
          <button style={S.stop} onClick={() => void window.th.dbgStop()}>■ stop</button>
        )}
      </div>

      {/* debugpy is the precondition; say so before a launch fails on it. */}
      {chosen?.hasDebugpy === false && (
        <div style={S.warn}>
          debugpy is not installed in this interpreter —{" "}
          <code style={S.code}>{chosen.path} -m pip install debugpy</code>
        </div>
      )}
      {error && <div style={S.error}>{error}</div>}

      <div style={S.steps}>
        <Step label="continue" glyph="▶" on={paused} onClick={() => window.th.dbgContinue()} />
        <Step label="step over" glyph="⤼" on={paused} onClick={() => window.th.dbgStepOver()} />
        <Step label="step into" glyph="↧" on={paused} onClick={() => window.th.dbgStepIn()} />
        <Step label="step out" glyph="↥" on={paused} onClick={() => window.th.dbgStepOut()} />
        <Step label="pause" glyph="❙❙" on={status.state === "running"} onClick={() => window.th.dbgPause()} />
        <div style={{ flex: 1 }} />
        <span
          style={{
            ...S.state,
            color: paused ? C.yellow : running ? C.green : status.error ? C.red : C.faint,
          }}
          // The full reason, for the cases too long to sit in the bar.
          title={status.error ?? status.reason ?? status.state}
        >
          {status.state}
          {status.reason ? ` · ${status.reason}` : ""}
          {/* Without this the pane says a bare "terminated" and the actual
              cause -- a non-zero exit, a missing debugpy -- is invisible, so
              the program's own crash reads as a broken debugger. */}
          {status.error ? ` · ${status.error}` : ""}
        </span>
      </div>

      <div style={S.body}>
        <div style={S.col}>
          <div style={S.head}>call stack</div>
          {frames.length === 0 && <div style={S.none}>{paused ? "no frames" : "not paused"}</div>}
          {frames.map((f) => (
            <div key={f.id}
              style={{ ...S.frame, ...(f.id === frameId ? S.frameOn : null) }}
              onClick={() => {
                setFrameId(f.id);
                // Jumping to the source is the point of a stack view.
                if (f.path) props.onOpen?.(f.path, f.line);
              }}
              title={f.path ? `${f.path}:${f.line}` : f.name}>
              <span>{f.name}</span>
              <span style={S.frameAt}>{f.path ? f.path.split("/").pop() : ""}:{f.line}</span>
            </div>
          ))}
        </div>

        <div style={S.col}>
          <div style={S.head}>variables</div>
          {scopes.length === 0 && <div style={S.none}>not paused</div>}
          {scopes.map((s) => (
            <div key={s.variablesReference}>
              <div style={S.scope}>{s.name}{s.expensive ? " (not loaded)" : ""}</div>
              {(vars[s.variablesReference] ?? []).map((v) => (
                <div key={v.name} style={S.var} title={`${v.name}: ${v.value}`}>
                  <span style={S.varName}>{v.name}</span>
                  <span style={S.varValue}>{v.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div style={S.watchBar}>
        <input
          style={S.input}
          placeholder={paused ? "evaluate in the paused frame…" : "evaluate (pause first)"}
          value={expr}
          disabled={!paused}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void evaluate();
          }}
        />
      </div>
      {watch.length > 0 && (
        <div style={S.watch}>
          {watch.map((w, i) => (
            <div key={i} style={S.var}>
              <span style={S.varName}>{w.expr}</span>
              <span style={{ ...S.varValue, color: w.error ? C.red : C.dim }}>
                {w.error ?? w.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {output.length > 0 && (
        <div style={S.output}>
          {output.map((o, i) => (
            <span key={i} style={{ color: o.category === "stderr" ? C.red : C.dim }}>{o.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Step(props: { label: string; glyph: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      disabled={!props.on}
      title={props.label}
      style={{ ...S.step, opacity: props.on ? 1 : 0.3, cursor: props.on ? "pointer" : "default" }}
    >
      {props.glyph}
    </button>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: {
    display: "flex", flexDirection: "column", height: "100%", background: C.panel,
    color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden",
  },
  bar: {
    display: "flex", alignItems: "center", gap: 5, padding: "5px 8px",
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
    // Two selects and a start button do not fit a narrow pane. Wrapping keeps
    // the start button reachable; clipping would put it past the edge with
    // nothing to scroll, which is what a 222px-wide pane did.
    flexWrap: "wrap", rowGap: 4, minWidth: 0,
  },
  select: {
    background: C.bg, color: C.fg, border: `1px solid ${C.line}`, borderRadius: 4,
    padding: "2px 5px", fontSize: 11, maxWidth: 190, fontFamily: "inherit",
    // May shrink below its content: the label truncates, which is far better
    // than pushing the start button out of the pane.
    minWidth: 0, flexShrink: 1,
  },
  go: {
    padding: "2px 10px", borderRadius: 4, border: `1px solid ${C.green}`,
    background: "transparent", color: C.green, fontSize: 11, cursor: "pointer",
  },
  stop: {
    padding: "2px 10px", borderRadius: 4, border: `1px solid ${C.red}`,
    background: "transparent", color: C.red, fontSize: 11, cursor: "pointer",
  },
  warn: {
    padding: "5px 9px", background: "#2b2410", color: C.yellow, fontSize: 11,
    borderBottom: `1px solid ${C.line}`,
  },
  code: { fontFamily: "Menlo, monospace", fontSize: 10 },
  error: {
    padding: "5px 9px", background: "#2b1414", color: C.red, fontSize: 11,
    borderBottom: `1px solid ${C.line}`,
  },
  steps: {
    display: "flex", alignItems: "center", gap: 3, padding: "4px 8px",
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  step: {
    width: 26, height: 20, borderRadius: 4, border: `1px solid ${C.line}`,
    background: "transparent", color: C.fg, fontSize: 11, padding: 0,
  },
  state: { fontSize: 10, fontFamily: "Menlo, monospace" },
  body: { flex: 1, display: "flex", minHeight: 0 },
  // minHeight:0 as well as minWidth:0: a deep call stack is taller than the
  // pane, and without it the column grows instead of scrolling.
  col: {
    flex: 1, overflow: "auto", minWidth: 0, minHeight: 0,
    borderRight: `1px solid ${C.line}`,
  },
  head: {
    padding: "4px 9px", color: C.faint, fontSize: 10, textTransform: "uppercase",
    letterSpacing: 0.4, position: "sticky", top: 0, background: C.panel,
  },
  none: { padding: "9px", color: C.faint, fontSize: 11, textAlign: "center" },
  frame: {
    display: "flex", gap: 7, padding: "2px 9px", cursor: "pointer",
    fontFamily: "Menlo, monospace", fontSize: 11, whiteSpace: "nowrap",
  },
  frameOn: { background: C.chromeHi },
  frameAt: { color: C.faint, marginLeft: "auto" },
  scope: { padding: "3px 9px", color: C.accent, fontSize: 10 },
  var: {
    display: "flex", gap: 7, padding: "1px 9px 1px 16px",
    fontFamily: "Menlo, monospace", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden",
  },
  varName: { color: C.fg, flexShrink: 0 },
  varValue: { color: C.dim, overflow: "hidden", textOverflow: "ellipsis" },
  watchBar: { padding: "5px 8px", borderTop: `1px solid ${C.line}`, flexShrink: 0 },
  input: {
    width: "100%", boxSizing: "border-box", background: C.bg, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 7px",
    fontSize: 11, outline: "none", fontFamily: "Menlo, monospace",
  },
  watch: { maxHeight: 90, overflow: "auto", borderTop: `1px solid ${C.line}`, flexShrink: 0 },
  output: {
    maxHeight: 110, overflow: "auto", borderTop: `1px solid ${C.line}`,
    padding: "5px 9px", fontFamily: "Menlo, monospace", fontSize: 11,
    whiteSpace: "pre-wrap", flexShrink: 0,
  },
};
