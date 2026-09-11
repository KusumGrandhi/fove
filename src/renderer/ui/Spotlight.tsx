/**
 * Spotlight: one overlay for finding anything in the repository.
 *
 * The app already had both halves of this and neither was where a hand
 * reaches for it. File-finding lived in the command palette, mixed in with
 * worktrees and layout presets; text search lived in a pane you had to split
 * open first, which is a layout decision imposed on you for asking a
 * question. Both are the same gesture -- "where is that thing" -- so they are
 * one surface here, and it floats over the workspace rather than rearranging
 * it.
 *
 * The two result kinds share a query and a cursor but not a search: paths and
 * contents come back from separate ripgrep passes, and a file whose *name*
 * matches is a different answer than a line that mentions it. So they are two
 * sections in one list, files first -- typing `Search.tsx` almost always
 * means the file, and burying it under the ninety lines that mention the word
 * would answer a question nobody asked.
 *
 * Enter opens the highlighted row in the editor, at its line when it has one.
 * That is the whole point: the overlay is a way *through* to a file, not a
 * place to read results in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C } from "./Chrome.js";

/** Mirrors SearchMatch in main/search.ts, which is what arrives over IPC. */
interface Match {
  path: string;
  /** 0 for a filename match, which has no line to point at. */
  line: number;
  text: string;
  start: number;
  end: number;
  /** The query matched the path rather than the contents. */
  isPath?: boolean;
  /** A path hit that matched as a substring rather than a subsequence. */
  exact?: boolean;
}

/** A row in the flattened list: what the cursor moves over and Enter opens. */
interface Row {
  key: string;
  match: Match;
}

/**
 * Long enough to skip intermediate keystrokes, short enough to feel direct.
 *
 * The same value the search pane uses. Spotlight is opened to type a whole
 * word into, so the first keystrokes are never the real query.
 */
const DEBOUNCE_MS = 160;

/**
 * How many content matches to show per file before collapsing the rest.
 *
 * A file that mentions the query eighty times would otherwise push every
 * other file off the list, and the eightieth hit is never the one wanted.
 */
const PER_FILE_CAP = 4;

/** Total rows rendered. Beyond this the list is a scroll, not an answer. */
const ROW_CAP = 200;

export function Spotlight(props: {
  cwd: string;
  /** Opens a file in the editor, at `line` when the row has one. */
  onOpen: (path: string, line?: number) => void;
  onClose: () => void;
}) {
  // A stable id, so this overlay's searches supersede only its own.
  const id = useMemo(() => `spotlight-${Math.random().toString(36).slice(2)}`, []);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  /** Set once a search has completed, so "no matches" waits for an answer. */
  const [settled, setSettled] = useState(false);
  /** Why the search could not run at all, if that is what happened. */
  const [failure, setFailure] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const offMatch = window.th.onSearchMatch((gotId, batch) => {
      if (gotId !== id) return;
      setMatches((prev) => [...prev, ...(batch as Match[])]);
    });
    const offDone = window.th.onSearchDone((gotId, _count, _truncated, reason) => {
      if (gotId !== id) return;
      setSearching(false);
      setSettled(true);
      // A search that could not run is not a search that found nothing.
      setFailure(reason ?? null);
    });
    return () => { offMatch(); offDone(); };
  }, [id]);

  // Closing the overlay stops the ripgrep processes behind it.
  useEffect(() => () => window.th.searchCancel(id), [id]);

  const run = useCallback(
    (q: string) => {
      setMatches([]);
      setSettled(false);
      if (!q.trim()) {
        setSearching(false);
        window.th.searchCancel(id);
        return;
      }
      setSearching(true);
      // Literal, case-insensitive: Spotlight is for finding a known name, and
      // a regex mode here would be a second thing to explain. The search pane
      // keeps the toggles for when the query is really a pattern.
      window.th.searchStart(id, { query: q, cwd: props.cwd });
    },
    [id, props.cwd],
  );

  /*
   * `run` is reached through a ref rather than listed as a dependency.
   *
   * It is recreated on every render caused by an arriving result batch, so
   * depending on it directly tore this effect down mid-search -- the cleanup
   * cancelled the debounce timer before it ever fired. The search pane hit
   * the same thing.
   */
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runRef.current(query), DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [query]);

  /** Filename hits, in the order the path pass ranked them. */
  const files = useMemo(() => matches.filter((m) => m.isPath), [matches]);

  /**
   * Content hits grouped by file, capped per file and overall.
   *
   * Grouping preserves the order results arrived in, which is ripgrep's
   * traversal order -- stable enough that the list does not reshuffle under
   * the cursor as later batches land.
   */
  const groups = useMemo(() => {
    const byFile = new Map<string, Match[]>();
    for (const m of matches) {
      if (m.isPath) continue;
      const list = byFile.get(m.path);
      if (list) list.push(m);
      else byFile.set(m.path, [m]);
    }
    return [...byFile.entries()];
  }, [matches]);

  /**
   * The flat list the cursor moves over.
   *
   * Section headings are rendered from the same data but are not rows: an
   * arrow key should never land on a heading, because Enter would have
   * nothing to open.
   */
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const m of files) {
      if (out.length >= ROW_CAP) break;
      out.push({ key: `p:${m.path}`, match: m });
    }
    for (const [path, hits] of groups) {
      for (const m of hits.slice(0, PER_FILE_CAP)) {
        if (out.length >= ROW_CAP) break;
        out.push({ key: `c:${path}:${m.line}:${m.start}`, match: m });
      }
    }
    return out;
  }, [files, groups]);

  // A new query is a new list: an out-of-range cursor highlights nothing and
  // Enter would do nothing.
  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows.length]);

  const choose = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      const m = row.match;
      // Close first: opening a file rearranges panes underneath, and the
      // overlay should be gone before that happens rather than racing it.
      props.onClose();
      props.onOpen(`${props.cwd}/${m.path}`, m.line > 0 ? m.line : undefined);
    },
    [props],
  );

  /** Where each section starts, so headings render in the right places. */
  const contentsAt = files.length;

  return (
    // The scrim closes on click, which is the expected way out of an overlay.
    <div style={S.scrim} onMouseDown={props.onClose}>
      <div style={S.box} onMouseDown={(e) => e.stopPropagation()}>
        <div style={S.inputRow}>
          <span style={S.glass}>⌕</span>
          <input
            autoFocus
            value={query}
            placeholder="Find a file, or search the code…"
            onChange={(e) => setQuery(e.target.value)}
            style={S.input}
            onKeyDown={(e) => {
              // The app's global shortcuts must not fire while typing here.
              e.stopPropagation();
              if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(rows[cursor]);
              }
            }}
          />
          {searching && <span style={S.spinner}>searching…</span>}
        </div>

        <div style={S.list} ref={listRef}>
          {rows.length === 0 && (
            <div style={S.none}>
              {!query.trim()
                ? "Type to find a file by name, or any text in the code."
                : searching || !settled
                  ? "searching…"
                  : failure
                    ? failure
                    : "no matches"}
            </div>
          )}

          {rows.map((row, i) => {
            const m = row.match;
            const head =
              i === 0 && files.length > 0
                ? "FILES"
                : i === contentsAt && groups.length > 0
                  ? "CODE"
                  : null;
            // A file heading inside the contents section: the row above
            // belongs to a different file.
            const prev = rows[i - 1]?.match;
            const newFile =
              !m.isPath && (i === contentsAt || prev?.path !== m.path);

            return (
              <div key={row.key}>
                {head && <div style={S.section}>{head}</div>}
                {newFile && (
                  <div style={S.fileHead} title={m.path}>{m.path}</div>
                )}
                <div
                  data-row={i}
                  style={{ ...S.row, ...(i === cursor ? S.rowOn : null) }}
                  // Hover moves the cursor so mouse and keyboard never
                  // disagree about which row Enter would take.
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(row); }}
                  title={m.isPath ? m.path : `${m.path}:${m.line}`}
                >
                  {m.isPath ? (
                    <>
                      <span style={S.icon}>◧</span>
                      <span style={S.pathText}>
                        <Highlight text={m.text} start={m.start} end={m.end} />
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={S.lineNo}>{m.line}</span>
                      <span style={S.snippet}>
                        <Highlight
                          text={m.text.replace(/^\s+/, "")}
                          // The leading whitespace trimmed above has to come
                          // off the offsets too, or the highlight slides.
                          start={m.start - lead(m.text)}
                          end={m.end - lead(m.text)}
                        />
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={S.footer}>
          <Key>↑↓</Key> move
          <Key>↵</Key> open in editor
          <Key>esc</Key> close
          <div style={{ flex: 1 }} />
          {rows.length > 0 && (
            <span>
              {files.length > 0 && `${files.length} file${files.length === 1 ? "" : "s"}`}
              {files.length > 0 && groups.length > 0 && " · "}
              {groups.length > 0 && `${groups.length} with matches`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** How much whitespace a snippet loses to trimming, in characters. */
function lead(text: string): number {
  return text.length - text.replace(/^\s+/, "").length;
}

/**
 * The matched span, marked.
 *
 * Offsets arrive as byte offsets from ripgrep and are used here as character
 * indices. They agree for ASCII, which nearly every match is; a snippet with
 * multibyte text before the match highlights slightly off rather than
 * wrongly, and the row still opens the right line.
 */
function Highlight(props: { text: string; start: number; end: number }) {
  const { text } = props;
  const start = Math.max(0, Math.min(props.start, text.length));
  const end = Math.max(start, Math.min(props.end, text.length));
  if (end <= start) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark style={S.mark}>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function Key(props: { children: React.ReactNode }) {
  return <kbd style={S.kbd}>{props.children}</kbd>;
}

const S: Record<string, React.CSSProperties> = {
  scrim: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", justifyContent: "center", alignItems: "flex-start",
    paddingTop: "11vh", zIndex: 60,
  },
  box: {
    width: "min(720px, 90vw)", background: C.panel, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)", fontFamily: "system-ui", fontSize: 12,
    display: "flex", flexDirection: "column",
  },
  inputRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "0 14px",
    borderBottom: `1px solid ${C.line}`,
  },
  glass: { color: C.faint, fontSize: 15, flexShrink: 0 },
  input: {
    flex: 1, minWidth: 0, background: "transparent", color: C.fg,
    border: "none", padding: "12px 0", fontSize: 14, outline: "none",
    fontFamily: "inherit",
  },
  spinner: { color: C.faint, fontSize: 10, flexShrink: 0 },
  list: { maxHeight: "54vh", overflow: "auto", minHeight: 0 },
  section: {
    padding: "7px 14px 3px", color: C.faint, fontSize: 9.5,
    letterSpacing: "0.08em", fontFamily: "Menlo, monospace",
  },
  fileHead: {
    padding: "4px 14px 2px", color: C.accent, fontSize: 10.5,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  row: {
    display: "flex", alignItems: "center", gap: 8, padding: "3px 14px",
    cursor: "pointer", whiteSpace: "pre", overflow: "hidden",
  },
  rowOn: { background: C.chromeHi },
  icon: { width: 14, textAlign: "center", color: C.faint, flexShrink: 0 },
  pathText: {
    overflow: "hidden", textOverflow: "ellipsis", fontSize: 12.5,
  },
  lineNo: {
    color: C.faint, minWidth: 40, textAlign: "right", flexShrink: 0,
    fontFamily: "Menlo, monospace", fontSize: 10.5,
  },
  snippet: {
    color: C.dim, overflow: "hidden", textOverflow: "ellipsis",
    fontFamily: "Menlo, monospace", fontSize: 11,
  },
  mark: { background: "#3a2d00", color: "#f0c000", borderRadius: 2 },
  none: { padding: "18px 14px", color: C.faint, textAlign: "center" },
  footer: {
    display: "flex", alignItems: "center", gap: 5,
    padding: "6px 12px", borderTop: `1px solid ${C.line}`,
    color: C.faint, fontSize: 10,
  },
  kbd: {
    fontFamily: "Menlo, monospace", fontSize: 9.5, border: `1px solid ${C.line}`,
    borderRadius: 3, padding: "0 4px", marginLeft: 6, marginRight: 1,
  },
};
