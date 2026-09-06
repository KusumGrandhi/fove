/**
 * Editor pane: Monaco -- the same editor VS Code uses -- with a file tree.
 *
 * Deliberately not a vim surface: this is click-to-place-cursor, real syntax
 * highlighting, multi-cursor, find/replace, and ⌘S to save.
 *
 * Saves carry the mtime the file had when it was opened, so an agent editing
 * the same file underneath produces a visible conflict rather than a silent
 * overwrite.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import jsonWorker from "../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker";
import cssWorker from "../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker";
import htmlWorker from "../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker";
import tsWorker from "../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import { C } from "../ui/Chrome.js";

interface OpenFile {
  path: string;
  name: string;
  content: string;
  mtimeMs: number;
  language: string;
  dirty: boolean;
  readonly?: boolean;
  error?: string;
}

interface Entry { name: string; path: string; dir: boolean; size: number }

/**
 * Monaco resolves its language services through this global. Vite bundles each
 * worker as its own entry (see vite.config.ts); without this the editor renders
 * but every language feature silently does nothing.
 */
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

/**
 * Resolve a file to a Monaco language id using Monaco's OWN registry.
 *
 * Monaco ships ~90 languages and each declares its extensions, filenames and
 * aliases. Asking the registry means every one of them works -- and new ones
 * arrive with a Monaco upgrade -- instead of depending on a hand-written map
 * that silently falls back to plaintext for anything not typed out by hand.
 */
/**
 * Extensions Monaco's registry does not claim.
 *
 * Rather than highlight them as plaintext, borrow the closest grammar Monaco
 * does ship. Vue SFCs are mostly HTML with script/style blocks; Haskell has no
 * bundled grammar, so F# is the nearest ML-family fit.
 */
const EXTRA_FILENAMES: Record<string, string> = {
  makefile: "makefile",
  "gnumakefile": "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  procfile: "yaml",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
};

const EXTRA_EXTENSIONS: Record<string, string> = {
  ".vue": "html",
  ".svelte": "html",
  ".astro": "html",
  ".hs": "fsharp",
  ".lhs": "fsharp",
  ".zig": "cpp",
  ".nim": "python",
  ".v": "go",
  ".gleam": "rust",
  ".prisma": "graphql",
  ".mdx": "markdown",
  ".tfvars": "hcl",
  ".env": "ini",
  ".gitignore": "ini",
  ".jsonl": "json",
  ".ndjson": "json",
};

function languageForPath(path: string): string {
  const file = (path.split("/").pop() ?? path).toLowerCase();
  const dot = file.lastIndexOf(".");
  const ext = dot > 0 ? file.slice(dot) : "";

  // Dotfile families: ".env", ".env.local", ".env.production" all read as ini.
  if (file.startsWith(".env")) return "ini";
  if (EXTRA_FILENAMES[file]) return EXTRA_FILENAMES[file]!;

  let extMatch: string | undefined;
  for (const lang of monaco.languages.getLanguages()) {
    // An exact filename wins over an extension: "Dockerfile", "Makefile",
    // ".bashrc" and friends carry no useful extension.
    if (lang.filenames?.some((f) => f.toLowerCase() === file)) return lang.id;
    if (lang.filenamePatterns?.some((p) =>
      new RegExp(`^${p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(file),
    )) {
      return lang.id;
    }
    if (!extMatch && ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) {
      extMatch = lang.id;
    }
  }
  return extMatch ?? EXTRA_EXTENSIONS[ext] ?? "plaintext";
}

/** Exposed so the smoke test can interrogate language resolution. */
(globalThis as unknown as { monaco: typeof monaco }).monaco = monaco;
(globalThis as unknown as { __thLanguageForPath: (p: string) => string }).__thLanguageForPath =
  (p: string) => languageForPath(p);

/** One dark theme, defined once, matching the app chrome. */
let themeReady = false;
function ensureTheme(): void {
  if (themeReady) return;
  monaco.editor.defineTheme("th-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0d0d11",
      "editorGutter.background": "#0d0d11",
      "editor.lineHighlightBackground": "#15151c",
      "editorLineNumber.foreground": "#3a3a44",
      "editorLineNumber.activeForeground": "#8a8a93",
    },
  });
  themeReady = true;
}

export function EditorPane(props: { cwd: string; initialPath?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  /** One Monaco model per file, so undo history survives tab switches. */
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());

  const [dir, setDir] = useState(props.cwd);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);

  const active = files.find((f) => f.path === activePath) ?? null;

  // ---- file tree ----------------------------------------------------------
  const listDir = useCallback(async (d: string) => {
    setDir(d);
    setEntries((await window.th.fileList(d)) as Entry[]);
  }, []);

  useEffect(() => { void listDir(props.cwd); }, [props.cwd, listDir]);

  // ---- open / save --------------------------------------------------------
  const openFile = useCallback(async (path: string) => {
    const existing = modelsRef.current.get(path);
    if (existing) { setActivePath(path); return; }

    const r = (await window.th.fileRead(path)) as OpenFile & { error?: string };
    // Monaco's registry is authoritative; main's map is only a hint.
    const language = languageForPath(path);
    const file: OpenFile = {
      path,
      name: path.split("/").pop() ?? path,
      content: r.content ?? "",
      mtimeMs: r.mtimeMs ?? 0,
      language,
      dirty: false,
      readonly: r.readonly,
      error: r.error,
    };
    if (!file.error) {
      const model = monaco.editor.createModel(file.content, file.language);
      model.onDidChangeContent(() => {
        setFiles((prev) =>
          prev.map((f) => (f.path === path ? { ...f, dirty: true } : f)),
        );
      });
      modelsRef.current.set(path, model);
    }
    setFiles((prev) => [...prev.filter((f) => f.path !== path), file]);
    setActivePath(path);
    if (file.error) setNotice(`${file.name}: ${file.error}`);
  }, []);

  const save = useCallback(async () => {
    const f = files.find((x) => x.path === activePath);
    const model = activePath ? modelsRef.current.get(activePath) : undefined;
    if (!f || !model || f.readonly) return;
    const content = model.getValue();
    const r = (await window.th.fileWrite(f.path, content, f.mtimeMs)) as {
      ok: boolean; mtimeMs?: number; error?: string; conflict?: boolean;
    };
    if (r.ok) {
      setFiles((prev) =>
        prev.map((x) => (x.path === f.path ? { ...x, dirty: false, mtimeMs: r.mtimeMs ?? x.mtimeMs } : x)),
      );
      setNotice(`saved ${f.name}`);
      setTimeout(() => setNotice(null), 1600);
    } else {
      setNotice(r.conflict ? `${f.name} changed on disk — reopen to merge` : `save failed: ${r.error}`);
    }
  }, [files, activePath]);

  const closeFile = useCallback((path: string) => {
    modelsRef.current.get(path)?.dispose();
    modelsRef.current.delete(path);
    setFiles((prev) => {
      const rest = prev.filter((f) => f.path !== path);
      if (activePath === path) setActivePath(rest[rest.length - 1]?.path ?? null);
      return rest;
    });
  }, [activePath]);

  // ---- monaco lifecycle ---------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureTheme();
    const ed = monaco.editor.create(host, {
      theme: "th-dark",
      automaticLayout: true,
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 8 },
    });
    editorRef.current = ed;
    return () => {
      ed.dispose();
      for (const m of modelsRef.current.values()) m.dispose();
      modelsRef.current.clear();
      editorRef.current = null;
    };
  }, []);

  // Swap the model when the active tab changes.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = activePath ? modelsRef.current.get(activePath) : undefined;
    ed.setModel(model ?? null);
    ed.updateOptions({ readOnly: !!active?.readonly });
    if (model) ed.focus();
  }, [activePath, active?.readonly]);

  // ⌘S saves, scoped to this pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        if (!hostRef.current?.closest("[data-pane]")?.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  const parent = dir.replace(/\/[^/]+$/, "") || "/";

  return (
    <div style={S.pane}>
      <div style={S.toolbar}>
        <button style={S.iconBtn} onClick={() => setTreeOpen((v) => !v)} title="Toggle file tree">
          {treeOpen ? "◧" : "▢"}
        </button>
        <div style={S.tabs}>
          {files.map((f) => (
            <div
              key={f.path}
              onClick={() => setActivePath(f.path)}
              style={{ ...S.tab, ...(f.path === activePath ? S.tabActive : null) }}
              title={f.path}
            >
              <span>{f.name}{f.dirty ? " •" : ""}</span>
              <button
                style={S.tabClose}
                onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {notice && <span style={S.notice}>{notice}</span>}
        <button
          style={{ ...S.iconBtn, opacity: active?.dirty ? 1 : 0.4 }}
          onClick={() => void save()}
          title="Save (⌘S)"
          disabled={!active?.dirty}
        >
          save
        </button>
        {active && (
          <button
            style={S.iconBtn}
            onClick={() => window.th.openInEditor(active.path)}
            title="Open in VS Code"
          >
            ↗
          </button>
        )}
      </div>

      <div style={S.body}>
        {treeOpen && (
          <div style={S.tree}>
            <div style={S.treePath} title={dir}>
              <button style={S.upBtn} onClick={() => void listDir(parent)} title="Parent folder">↑</button>
              <span style={S.ellipsis}>{dir.split("/").pop() || "/"}</span>
            </div>
            {entries.map((e) => (
              <div
                key={e.path}
                onClick={() => (e.dir ? void listDir(e.path) : void openFile(e.path))}
                style={{
                  ...S.treeRow,
                  color: e.path === activePath ? C.fg : e.dir ? C.dim : C.faint,
                  background: e.path === activePath ? "#1e2636" : undefined,
                }}
                title={e.path}
              >
                <span style={{ width: 13 }}>{e.dir ? "▸" : "·"}</span>
                <span style={S.ellipsis}>{e.name}</span>
              </div>
            ))}
            {entries.length === 0 && <div style={S.treeEmpty}>empty</div>}
          </div>
        )}

        <div style={S.editorWrap}>
          <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
          {!activePath && (
            <div style={S.empty}>select a file from the tree</div>
          )}
          {active?.error && (
            <div style={S.empty}>{active.name}: {active.error}</div>
          )}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: { display: "flex", flexDirection: "column", height: "100%",
          background: "#0d0d11", color: C.fg, fontFamily: "system-ui", fontSize: 12,
          overflow: "hidden" },
  toolbar: { display: "flex", alignItems: "center", gap: 4, padding: "3px 7px",
             background: "#14141a", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
             minHeight: 26 },
  tabs: { display: "flex", gap: 2, overflowX: "auto", maxWidth: "60%" },
  tab: { display: "flex", alignItems: "center", gap: 5, padding: "2px 7px",
         borderRadius: 4, color: C.faint, cursor: "pointer", whiteSpace: "nowrap",
         border: "1px solid transparent" },
  tabActive: { background: "#1e2636", color: C.fg, border: `1px solid ${C.line}` },
  tabClose: { background: "transparent", border: "none", color: C.faint,
              cursor: "pointer", fontSize: 9, padding: 0, lineHeight: 1 },
  iconBtn: { background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
             borderRadius: 4, padding: "1px 7px", cursor: "pointer", fontSize: 11 },
  notice: { color: C.dim, fontSize: 11, marginRight: 4 },
  body: { display: "flex", flex: 1, minHeight: 0 },
  tree: { width: 190, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.line}`,
          padding: "3px 0", background: "#0f0f14" },
  treePath: { display: "flex", alignItems: "center", gap: 5, padding: "3px 8px",
              color: C.dim, borderBottom: `1px solid ${C.line}`, marginBottom: 3 },
  upBtn: { background: "transparent", border: "none", color: C.faint, cursor: "pointer",
           fontSize: 11, padding: 0 },
  treeRow: { display: "flex", gap: 4, alignItems: "center", padding: "1px 8px",
             cursor: "pointer", lineHeight: "17px" },
  treeEmpty: { color: "#33333c", padding: "6px 9px", fontSize: 11 },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  editorWrap: { flex: 1, minWidth: 0, position: "relative" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center",
           justifyContent: "center", color: "#33333c", fontSize: 11,
           pointerEvents: "none", background: "#0d0d11" },
};
