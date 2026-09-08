/**
 * Git pane: what changed, on which branch/worktree.
 *
 * Built for reviewing an agent's work: the change list is the primary content,
 * and clicking a file shows its diff. Files open in fove's own editor pane;
 * "open in VS Code" remains available as an explicit escape hatch on
 * every file and every line -- the easy path, which stays even once an in-app
 * editor exists.
 */

import { useCallback, useEffect, useState } from "react";
import type { FileChange, FileDiff, RepoStatus, Worktree } from "../../shared/git-parse.js";
import { statusLabel } from "../../shared/git-parse.js";
import { GitActions } from "./GitActions.js";

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

export function GitStatusPane(props: {
  cwd: string;
  /** Open a file in fove's own editor pane. */
  onOpen?: (path: string, line?: number) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await window.th.gitRoot(props.cwd);
    setRoot(r);
    if (r) {
      const [s, w] = await Promise.all([
        window.th.gitStatus(r) as Promise<RepoStatus | null>,
        window.th.gitWorktrees(r) as Promise<Worktree[]>,
      ]);
      setStatus(s);
      setWorktrees(w);
    }
    setBusy(false);
  }, [props.cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while the pane is open: an agent changes files behind our back.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

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
    <div style={S.pane}>
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

      <GitActions
        root={root}
        branch={status?.branch}
        staged={(status?.files ?? []).filter((f) => f.staged !== null).map((f) => f.path)}
        unstaged={(status?.files ?? []).filter((f) => f.unstaged !== null).map((f) => f.path)}
        onChanged={() => void refresh()}
        onOpen={props.onOpen}
      />

      <div style={S.split}>
        <div style={S.list}>
          {worktrees.length > 1 && (
            <>
              <div style={S.sectionLabel}>worktrees</div>
              {worktrees.map((w) => (
                <div key={w.path} style={{ ...S.row, color: w.current ? C.fg : C.faint }}>
                  <span style={{ width: 12 }}>{w.current ? "●" : "○"}</span>
                  <span style={S.ellipsis}>{w.branch ?? "(detached)"}</span>
                </div>
              ))}
            </>
          )}

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
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: { display: "flex", flexDirection: "column", height: "100%", background: C.bg,
          color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden" },
  header: { display: "flex", gap: 6, alignItems: "center", padding: "5px 9px",
            background: C.panel, borderBottom: `1px solid ${C.line}`, flexShrink: 0 },
  split: { display: "flex", flex: 1, minHeight: 0 },
  list: { width: 240, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.line}`,
          padding: "4px 0" },
  sectionLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase",
                  padding: "6px 9px 2px", letterSpacing: 0.5 },
  row: { display: "flex", gap: 5, alignItems: "center", padding: "2px 9px", lineHeight: "17px" },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  diff: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  diffHeader: { display: "flex", gap: 8, alignItems: "center", padding: "5px 9px",
                borderBottom: `1px solid ${C.line}`, color: C.dim, flexShrink: 0 },
  openBtn: { background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
             borderRadius: 4, padding: "1px 7px", cursor: "pointer", fontSize: 11 },
  diffBody: { flex: 1, overflow: "auto", fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 11 },
  hunkHeader: { color: C.faint, background: "#101017", padding: "3px 9px",
                borderTop: `1px solid ${C.line}`, position: "sticky", top: 0 },
  diffLine: { display: "flex", cursor: "pointer", lineHeight: "16px", whiteSpace: "pre" },
  gutter: { width: 44, textAlign: "right", paddingRight: 8, color: C.faint, flexShrink: 0 },
  code: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" },
};
