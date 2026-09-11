/**
 * Codebase search.
 *
 * Results stream in as ripgrep finds them rather than appearing all at once,
 * so a search across a large repository is useful immediately instead of after
 * it finishes. Each result opens in the editor at its exact line, through the
 * same path the git diff and the IDE server already use.
 *
 * Queries are debounced and superseded: typing fires one per keystroke, and
 * without cancellation the results would interleave and whichever search
 * *finished* last would win rather than whichever was *asked* last.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C } from "../ui/Chrome.js";

interface Match {
  path: string;
  /** 0 for a filename match, which has no line to point at. */
  line: number;
  text: string;
  start: number;
  end: number;
  /** The query matched the path rather than the contents. */
  isPath?: boolean;
}

/** Long enough to skip intermediate keystrokes, short enough to feel direct. */
const DEBOUNCE_MS = 180;

export function SearchPane(props: {
  cwd: string;
  onOpen?: (path: string, line?: number) => void;
}) {
  // A stable id per pane, so this pane's searches supersede only its own.
  const id = useMemo(() => `search-${Math.random().toString(36).slice(2)}`, []);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [glob, setGlob] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [status, setStatus] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const offMatch = window.th.onSearchMatch((gotId, batch) => {
      if (gotId !== id) return;
      setMatches((prev) => [...prev, ...(batch as Match[])]);
    });
    const offDone = window.th.onSearchDone((gotId, count, truncated, reason) => {
      if (gotId !== id) return;
      setSearching(false);
      setStatus(
        // A search that could not run is not a search that found nothing.
        reason
          ? reason
          : count === 0
            ? noMatchHint(queryRef.current, regexRef.current)
            : `${count} match${count === 1 ? "" : "es"}${truncated ? " (stopped at the cap)" : ""}`,
      );
    });
    return () => { offMatch(); offDone(); };
  }, [id]);

  // Cancel on unmount, so closing the pane stops the process.
  useEffect(() => () => window.th.searchCancel(id), [id]);

  // The done-handler is registered once, so it reads these through refs
  // rather than closing over the first render's values.
  const queryRef = useRef(query);
  queryRef.current = query;
  const regexRef = useRef(regex);
  regexRef.current = regex;

  const run = useCallback(
    (q: string) => {
      setMatches([]);
      if (!q.trim()) {
        setStatus("");
        setSearching(false);
        window.th.searchCancel(id);
        return;
      }
      setSearching(true);
      setStatus("searching…");
      window.th.searchStart(id, {
        query: q,
        cwd: props.cwd,
        regex,
        caseSensitive,
        wholeWord,
        globs: glob.trim() ? glob.split(",").map((g) => g.trim()).filter(Boolean) : [],
      });
    },
    [id, props.cwd, regex, caseSensitive, wholeWord, glob],
  );

  /**
   * Re-run when the query or any option changes.
   *
   * `run` is held in a ref rather than listed as a dependency. It is recreated
   * whenever any option changes *and* on every render caused by an arriving
   * result batch, so depending on it directly made this effect tear down and
   * re-arm mid-search -- the cleanup cancelled the timer before it ever fired.
   */
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runRef.current(query), DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
    // Options are included so toggling one re-runs the current query.
  }, [query, regex, caseSensitive, wholeWord, glob]);

  /** Filename hits, listed on their own above the content results. */
  const fileHits = useMemo(() => matches.filter((m) => m.isPath), [matches]);

  /** Group content matches by file, preserving the order results arrived in. */
  const grouped = useMemo(() => {
    const byFile = new Map<string, Match[]>();
    for (const m of matches) {
      if (m.isPath) continue;
      const list = byFile.get(m.path);
      if (list) list.push(m);
      else byFile.set(m.path, [m]);
    }
    return [...byFile.entries()];
  }, [matches]);

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <input
          autoFocus
          style={S.input}
          placeholder="search the codebase…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // The app's shortcuts must not fire while typing a query.
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Toggle on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match case">Aa</Toggle>
        <Toggle on={wholeWord} onClick={() => setWholeWord((v) => !v)} title="Whole word">ab|</Toggle>
        <Toggle on={regex} onClick={() => setRegex((v) => !v)} title="Regular expression">.*</Toggle>
      </div>

      <div style={S.bar}>
        <input
          style={{ ...S.input, fontSize: 10 }}
          placeholder="files to include, e.g. *.ts, !*.test.ts"
          value={glob}
          onChange={(e) => setGlob(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>

      {status && (
        <div style={S.status}>
          {status}
          {searching && (
            <button style={S.cancel} onClick={() => { window.th.searchCancel(id); setSearching(false); setStatus("stopped"); }}>
              stop
            </button>
          )}
        </div>
      )}

      <div style={S.results}>
        {fileHits.length > 0 && (
          <div>
            <div style={S.section}>
              FILES
              <span style={{ color: C.faint, marginLeft: 6 }}>{fileHits.length}</span>
            </div>
            {fileHits.map((m) => (
              <div
                key={`path-${m.path}`}
                style={S.hit}
                title={m.path}
                onClick={() => props.onOpen?.(`${props.cwd}/${m.path}`)}
              >
                <span style={S.snippet}>
                  {m.text.slice(0, m.start)}
                  <mark style={S.mark}>{m.text.slice(m.start, m.end)}</mark>
                  {m.text.slice(m.end)}
                </span>
              </div>
            ))}
          </div>
        )}
        {fileHits.length > 0 && grouped.length > 0 && (
          <div style={S.section}>CONTENTS</div>
        )}
        {grouped.map(([path, hits]) => (
          <div key={path}>
            <div style={S.file} title={path}>
              {path} <span style={{ color: C.faint }}>{hits.length}</span>
            </div>
            {hits.map((m, i) => (
              <div
                key={`${m.line}-${i}`}
                style={S.hit}
                title={`${path}:${m.line}`}
                onClick={() => props.onOpen?.(`${props.cwd}/${path}`, m.line)}
              >
                <span style={S.lineNo}>{m.line}</span>
                <span style={S.snippet}>
                  {m.text.slice(0, m.start)}
                  <mark style={S.mark}>{m.text.slice(m.start, m.end)}</mark>
                  {m.text.slice(m.end)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Why a search found nothing, when the reason is the search itself.
 *
 * A bare "no matches" is true but unhelpful for the most common miss: typing
 * a filename like `agent.md` into a *contents* search. The dot is a literal
 * here, nothing contains that text, and the file you meant is sitting in the
 * tree -- so say which question was actually asked.
 */
function noMatchHint(query: string, regex: boolean): string {
  const q = query.trim();
  if (!regex && /[.*+?^$()[\]{}|\\]/.test(q)) {
    return `no matches — searched for the literal text "${q}"; use .* for a pattern`;
  }
  return "no matches";
}

function Toggle(props: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      style={{
        ...S.toggle,
        background: props.on ? "#1a2233" : "transparent",
        borderColor: props.on ? C.accent : C.line,
        color: props.on ? C.fg : C.faint,
      }}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: {
    display: "flex", flexDirection: "column", height: "100%", background: C.panel,
    color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden",
  },
  bar: {
    display: "flex", alignItems: "center", gap: 4, padding: "5px 8px",
    borderBottom: `1px solid ${C.line}`,
  },
  input: {
    flex: 1, minWidth: 0, background: C.bg, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 7px",
    fontSize: 11, outline: "none", fontFamily: "inherit",
  },
  toggle: {
    minWidth: 26, padding: "2px 5px", borderRadius: 4, border: "1px solid",
    fontSize: 10, cursor: "pointer", fontFamily: "Menlo, monospace",
  },
  status: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "3px 9px", color: C.faint, fontSize: 10,
  },
  cancel: {
    padding: "1px 7px", borderRadius: 3, border: `1px solid ${C.line}`,
    background: "transparent", color: C.fg, fontSize: 10, cursor: "pointer",
  },
  results: { flex: 1, overflow: "auto", minHeight: 0 },
  section: {
    padding: "5px 9px 3px", color: C.faint, fontSize: 9.5,
    letterSpacing: "0.08em", fontFamily: "Menlo, monospace",
  },
  file: {
    padding: "4px 9px", color: "#58a6ff", fontSize: 11,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    position: "sticky", top: 0, background: C.panel,
  },
  hit: {
    display: "flex", gap: 8, padding: "1px 9px 1px 18px",
    fontFamily: "Menlo, monospace", fontSize: 11, cursor: "pointer",
    whiteSpace: "pre", overflow: "hidden",
  },
  lineNo: { color: C.faint, minWidth: 38, textAlign: "right", flex: "0 0 auto" },
  snippet: { color: C.dim, overflow: "hidden", textOverflow: "ellipsis" },
  mark: { background: "#3a2d00", color: "#f0c000", borderRadius: 2 },
};
