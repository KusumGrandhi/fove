/**
 * Git pane: what changed, on which branch/worktree.
 *
 * Built for reviewing an agent's work: the change list is the primary content,
 * and clicking a file shows its diff. Files open in fove's own editor pane;
 * "open in VS Code" remains available as an explicit escape hatch on
 * every file and every line -- the easy path, which stays even once an in-app
 * editor exists.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileChange, FileDiff, RepoStatus } from "../../shared/git-parse.js";
import { statusLabel } from "../../shared/git-parse.js";
import { useGitActions } from "./GitActions.js";

const C = {
  bg: "#0d0d11", panel: "#14141a", line: "#22222a",
  fg: "#d8d8dc", dim: "#8a8a93", faint: "#5a5a63",
  add: "#3fb950", del: "#f05055", accent: "#2f6feb", warn: "#d29922",
};

const statusColor = (f: FileChange): string => {
  const s = f.staged ?? f.unstaged;
  return s === "added" || s === "untracked" ? C.add
    : s === "deleted" ? C.del
    : s === "renamed" ? C.accent
    : s === "unmerged" ? C.warn
    : C.dim;
};

/**
 * Below this width the file list and the diff stack instead of sitting side
 * by side. 520px is roughly where a 240px list stops leaving the diff enough
 * room to be worth reading.
 */
const STACK_BELOW_PX = 520;

export function GitStatusPane(props: {
  cwd: string;
  /** Open a file in fove's own editor pane. */
  onOpen?: (path: string, line?: number) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Stack the file list above the diff when the pane is too narrow to hold
   * both side by side.
   *
   * A fixed 240px list beside a diff is fine in a wide pane and useless in a
   * slim one -- at 650px the diff got what was left and rendered "select a
   * file" as two wrapped words. Measured rather than assumed, because a pane
   * is resized by dragging a divider, not by resizing the window.
   */
  const hostRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? 0) < STACK_BELOW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await window.th.gitRoot(props.cwd);
    setRoot(r);
    // Status only: this polls every 3s, and `git worktree list` was a second
    // subprocess per tick for a list nothing reads any more.
    if (r) setStatus((await window.th.gitStatus(r)) as RepoStatus | null);
    setBusy(false);
  }, [props.cwd]);

  /**
   * Stage or unstage specific paths, then re-read.
   *
   * The refresh is what redraws the row: a staged file's `+` becomes `−`, and
   * the commit form's counts above follow from the same status.
   */
  const stagePaths = useCallback(async (paths: string[]) => {
    if (!root) return;
    await window.th.gitStage(root, paths);
    await refresh();
  }, [root, refresh]);

  const unstagePaths = useCallback(async (paths: string[]) => {
    if (!root) return;
    await window.th.gitUnstage(root, paths);
    await refresh();
  }, [root, refresh]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while the pane is open: an agent changes files behind our back.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  /*
   * The commit form and the panel strip come from one hook so they share
   * `tab`, but they render on opposite sides of the file list below: commit
   * above it, graph/stash/worktree under it, which is the order you read in.
   */
  const git = useGitActions({
    root: root ?? "",
    branch: status?.branch,
    staged: (status?.files ?? []).filter((f) => f.staged !== null).map((f) => f.path),
    unstaged: (status?.files ?? []).filter((f) => f.unstaged !== null).map((f) => f.path),
    onChanged: () => void refresh(),
    onOpen: props.onOpen,
  });

  const openFile = useCallback(async (f: FileChange) => {
    setSelected(f);
    if (!root) return;
    // Untracked files have no diff against HEAD; render them as all-additions.
    const files =
      f.unstaged === "untracked"
        ? [await window.th.gitUntrackedDiff(root, f.path)].filter(Boolean)
        : ((await window.th.gitDiff(root, {
            path: f.path,
            staged: f.staged !== null && f.unstaged === null,
          })) as FileDiff[]);
    setDiff((files[0] as FileDiff) ?? null);
  }, [root]);

  if (!root) {
    return (
      <div style={{ ...S.pane, color: C.faint, padding: 12 }}>
        {busy ? "checking…" : "not a git repository"}
      </div>
    );
  }

  return (
    <div ref={hostRef} style={S.pane}>
      <div style={S.header}>
        <span style={{ color: C.accent }}>⎇ {status?.branch ?? "(detached)"}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span style={{ color: C.dim }}>
            {status.ahead > 0 ? ` ↑${status.ahead}` : ""}{status.behind > 0 ? ` ↓${status.behind}` : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: C.faint }}>{status?.files.length ?? 0} changed</span>
      </div>

      {git.form}

      <div style={{ ...S.split, flexDirection: narrow ? "column" : "row" }}>
        <div style={narrow ? S.listStacked : S.list}>
          {/*
            * No worktree list here.
            *
            * It was read-only -- a dot and a branch name, nothing to click --
            * and it cost seven rows above the changes list, which is what this
            * sidebar is for. Everything it said is said better elsewhere: the
            * header above names the branch you are in, the pane's own worktree
            * tab creates and closes them, and the toolbar picker switches.
            */}
          <div style={S.sectionLabel}>changes</div>
          {(status?.files ?? []).length === 0 && (
            <div style={{ ...S.row, color: C.faint }}>clean</div>
          )}
          {(status?.files ?? []).map((f) => (
            <div
              key={f.path}
              onClick={() => void openFile(f)}
              onDoubleClick={() => props.onOpen?.(`${root}/${f.path}`)}
              style={{
                ...S.row,
                cursor: "pointer",
                background: selected?.path === f.path ? "#1e2636" : undefined,
              }}
              title={`${f.path}${f.from ? ` (was ${f.from})` : ""} — double-click to open in the editor`}
            >
              <span style={{ width: 14, color: statusColor(f) }}>{statusLabel(f)}</span>
              <span style={{ ...S.ellipsis, color: selected?.path === f.path ? C.fg : C.dim }}>
                {f.path}
              </span>
              {/*
                * Per file, because "stage all (13)" is no help when three of
                * the thirteen belong in this commit.
                *
                * A file can be staged and unstaged at once -- edited, staged,
                * then edited again -- so these are two independent conditions
                * rather than one either/or: that file gets both buttons, and
                * each acts on its own half.
                *
                * The click must not reach the row, which selects the file and
                * loads its diff.
                */}
              {f.unstaged !== null && (
                <button
                  style={S.rowBtn}
                  title={`Stage ${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (root) void stagePaths([f.path]);
                  }}
                >
                  +
                </button>
              )}
              {f.staged !== null && (
                <button
                  style={S.rowBtn}
                  title={`Unstage ${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (root) void unstagePaths([f.path]);
                  }}
                >
                  −
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={S.diff}>
          {!selected && <div style={{ color: C.faint, padding: 10 }}>select a file</div>}
          {selected && diff?.binary && (
            <div style={{ color: C.faint, padding: 10 }}>binary file</div>
          )}
          {selected && diff && !diff.binary && (
            <>
              <div style={S.diffHeader}>
                <span style={S.ellipsis}>{diff.path}</span>
                <span style={{ color: C.add }}>+{diff.additions}</span>
                <span style={{ color: C.del }}>−{diff.deletions}</span>
                <button
                  style={S.openBtn}
                  title="Open in the editor pane"
                  onClick={() => props.onOpen?.(`${root}/${diff.path}`)}
                >
                  open
                </button>
                {/* The escape hatch stays, but is no longer the default. */}
                <button
                  style={S.openBtn}
                  title="Open in VS Code"
                  onClick={() => window.th.openInEditor(`${root}/${diff.path}`)}
                >
                  ↗
                </button>
              </div>
              <div style={S.diffBody}>
                {diff.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div style={S.hunkHeader}>
                      @@ {h.oldStart} → {h.newStart} @@ {h.header}
                    </div>
                    {h.lines.map((l, li) => (
                      <div
                        key={li}
                        onClick={() =>
                          props.onOpen?.(`${root}/${diff.path}`, l.newNo ?? l.oldNo)
                        }
                        style={{
                          ...S.diffLine,
                          background: l.kind === "add" ? "#0e2a16" : l.kind === "del" ? "#2d1214" : undefined,
                          color: l.kind === "add" ? C.add : l.kind === "del" ? C.del : C.dim,
                        }}
                        title="click to open at this line"
                      >
                        <span style={S.gutter}>{l.newNo ?? l.oldNo ?? ""}</span>
                        <span style={{ width: 10 }}>
                          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                        </span>
                        <span style={S.code}>{l.text || " "}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {diff.hunks.length === 0 && (
                  <div style={{ color: C.faint, padding: 10 }}>no textual changes</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* The lower half: whichever of graph/stash/worktree is open. */}
      <div style={S.panels}>{git.panels}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: { display: "flex", flexDirection: "column", height: "100%", background: C.bg,
          color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden" },
  header: { display: "flex", gap: 6, alignItems: "center", padding: "5px 9px",
            background: C.panel, borderBottom: `1px solid ${C.line}`, flexShrink: 0 },
  split: { display: "flex", flex: 1, minHeight: 0 },
  /*
   * The lower half. Capped and scrollable so an open panel -- 54 stashes, a
   * long graph -- cannot push the file list above it off the pane.
   */
  panels: { display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "55%",
            overflowY: "auto", flexShrink: 0, borderTop: `1px solid ${C.line}` },
  list: { width: 240, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.line}`,
          padding: "4px 0" },
  /*
   * Stacked: full width, and the divider moves to the bottom edge. The height
   * is capped rather than proportional so a long change list cannot push the
   * diff off the pane -- 45% leaves the diff the larger share, since it is the
   * thing being read.
   */
  listStacked: {
    width: "100%", flexShrink: 0, maxHeight: "45%", overflowY: "auto",
    borderBottom: `1px solid ${C.line}`, padding: "4px 0",
  },
  sectionLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase",
                  padding: "6px 9px 2px", letterSpacing: 0.5 },
  row: { display: "flex", gap: 5, alignItems: "center", padding: "2px 9px", lineHeight: "17px" },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  /*
   * Square and small: the row is a 17px line, and these sit at the end of a
   * path that is already ellipsised, so they must cost almost no width.
   * `flexShrink: 0` keeps them from being squeezed away when the pane is
   * narrow -- which is exactly when a long path wants to eat the row.
   */
  rowBtn: {
    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
    borderRadius: 3, width: 17, height: 15, lineHeight: "13px", padding: 0,
    cursor: "pointer", fontSize: 12, flexShrink: 0,
  },
  diff: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
  diffHeader: { display: "flex", gap: 8, alignItems: "center", padding: "5px 9px",
                borderBottom: `1px solid ${C.line}`, color: C.dim, flexShrink: 0 },
  openBtn: { background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
             borderRadius: 4, padding: "1px 7px", cursor: "pointer", fontSize: 11 },
  diffBody: { flex: 1, minHeight: 0, overflow: "auto", fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 11 },
  hunkHeader: { color: C.faint, background: "#101017", padding: "3px 9px",
                borderTop: `1px solid ${C.line}`, position: "sticky", top: 0,
                // Sticks to the top *and* to the left edge: without a width
                // tied to the scrolled content, scrolling right slides the
                // header's background out and leaves the text floating.
                left: 0, minWidth: "min-content" },
  // `min-content` so a long source line widens the row instead of being
  // squeezed to the container and clipped: diffBody scrolls horizontally, but
  // only if the rows may be wider than it.
  diffLine: {
    display: "flex", cursor: "pointer", lineHeight: "16px", whiteSpace: "pre",
    minWidth: "min-content",
  },
  gutter: { width: 44, textAlign: "right", paddingRight: 8, color: C.faint, flexShrink: 0 },
  code: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" },
};
