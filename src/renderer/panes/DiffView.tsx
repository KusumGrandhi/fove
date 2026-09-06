/**
 * The diff Claude asks you to approve.
 *
 * When Claude Code edits a file it calls `openDiff` on the IDE and *blocks*
 * until the editor answers "FILE_SAVED" or "DIFF_REJECTED". Without somewhere
 * to render that, the CLI sits at its confirmation prompt while the user sees
 * nothing -- so this is not decoration, it is the other half of the protocol.
 *
 * Rendered as an overlay rather than a pane: it is modal by nature (Claude is
 * waiting on it) and it must appear even when no editor pane is open.
 */

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { C } from "../ui/Chrome.js";
import { ensureTheme, languageForPath } from "./Editor.js";

export interface DiffRequest {
  id: string;
  oldPath: string;
  newPath: string;
  newContents: string;
  tabName: string;
}

export function DiffView(props: {
  req: DiffRequest;
  /** Resolves Claude's blocked call. */
  onVerdict: (id: string, verdict: "saved" | "rejected") => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const { req } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The diff can open before any editor pane has mounted, so the theme is
    // not guaranteed to be registered yet.
    ensureTheme();
    const language = languageForPath(req.newPath || req.oldPath);

    const diff = monaco.editor.createDiffEditor(host, {
      theme: "th-dark",
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = diff;

    let cancelled = false;
    void (async () => {
      // The "old" side is whatever is on disk now; an added file simply has none.
      let original = "";
      try {
        const r = (await window.th.fileRead(req.oldPath)) as { content?: string } | null;
        original = r?.content ?? "";
      } catch {
        original = "";
      }
      if (cancelled) return;
      diff.setModel({
        original: monaco.editor.createModel(original, language),
        modified: monaco.editor.createModel(req.newContents, language),
      });
    })();

    return () => {
      cancelled = true;
      const m = diff.getModel();
      diff.dispose();
      m?.original.dispose();
      m?.modified.dispose();
      editorRef.current = null;
    };
  }, [req.id, req.oldPath, req.newPath, req.newContents]);

  // Enter accepts, Escape rejects -- and either way Claude stops waiting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); props.onVerdict(req.id, "rejected"); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        props.onVerdict(req.id, "saved");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req.id, props]);

  const name = req.tabName || req.newPath.split("/").pop() || "diff";
  return (
    <div style={S.backdrop}>
      <div style={S.panel}>
        <div style={S.head}>
          <span style={{ color: C.fg }}>◧ {name}</span>
          <span style={S.path} title={req.newPath}>{req.newPath}</span>
          <div style={{ flex: 1 }} />
          <span style={S.hint}>Claude is waiting</span>
        </div>
        <div ref={hostRef} style={S.body} />
        <div style={S.foot}>
          <button style={S.reject} onClick={() => props.onVerdict(req.id, "rejected")}>
            Reject <span style={S.key}>esc</span>
          </button>
          <button style={S.accept} onClick={() => props.onVerdict(req.id, "saved")}>
            Accept <span style={S.key}>⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60,
    animation: "fove-fade-in 120ms ease-out",
  },
  panel: {
    width: "min(1200px, 92%)", height: "min(760px, 88%)", display: "flex",
    flexDirection: "column", background: "#0d0d11", border: `1px solid ${C.accent}`,
    borderRadius: 8, overflow: "hidden", boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
    animation: "fove-rise 160ms ease-out",
  },
  head: {
    display: "flex", alignItems: "center", gap: 10, padding: "7px 10px",
    background: "#15151c", borderBottom: "1px solid #23232c",
    fontFamily: "system-ui", fontSize: 12,
  },
  path: { color: C.faint, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 520 },
  hint: { color: "#d29922", fontSize: 11 },
  body: { flex: 1, minHeight: 0 },
  foot: {
    display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 10px",
    background: "#15151c", borderTop: "1px solid #23232c",
  },
  accept: {
    padding: "5px 14px", borderRadius: 5, border: "1px solid #2ea043",
    background: "#238636", color: "#fff", fontFamily: "system-ui", fontSize: 12, cursor: "pointer",
  },
  reject: {
    padding: "5px 14px", borderRadius: 5, border: "1px solid #3d3d46",
    background: "transparent", color: C.fg, fontFamily: "system-ui", fontSize: 12, cursor: "pointer",
  },
  key: { opacity: 0.6, marginLeft: 6, fontSize: 10 },
};
