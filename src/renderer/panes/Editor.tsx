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
import { ContextMenu, type MenuItem } from "../ui/ContextMenu.js";
import { flattenTree, ancestorsWithin } from "../../shared/tree-rows.js";

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

export function languageForPath(path: string): string {
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
export function ensureTheme(): void {
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

  /**
   * Breakpoint and paused-line styling.
   *
   * Injected rather than put in a stylesheet because Monaco addresses
   * decorations by class name only -- there is no inline-style path for a
   * glyph -- and this keeps the class and its appearance in one place.
   */
  const style = document.createElement("style");
  style.textContent = `
    /*
     * Monaco absolutely positions each glyph and sets its width and height
     * inline. Overriding those with !important collapsed every glyph but one
     * into the same place, so the dot is drawn with a background instead --
     * the element keeps the box Monaco gave it.
     */
    .fove-breakpoint {
      background: radial-gradient(circle at 50% 50%, #e5534b 0 4.5px, transparent 4.5px);
    }
    .fove-paused-line { background: rgba(210, 153, 34, 0.18); }
  `;
  document.head.appendChild(style);
  themeReady = true;
}

/** The path a model was opened under, since Monaco models carry no path of ours. */
function pathOfModel(
  models: Map<string, monaco.editor.ITextModel>,
  model: monaco.editor.ITextModel,
): string | null {
  for (const [path, m] of models) if (m === model) return path;
  return null;
}

export function EditorPane(props: {
  cwd: string;
  initialPath?: string;
  /** Line to reveal after opening, e.g. from a diff hunk. */
  initialLine?: number;
  /** Changes per request, so opening the same path twice still acts. */
  openNonce?: number;
  /** Breakpoints to draw in the gutter, owned by the app so the debugger shares them. */
  breakpoints?: { path: string; line: number }[];
  onToggleBreakpoint?: (path: string, line: number) => void;
  /** Where execution is currently paused, highlighted like a breakpoint's target. */
  pausedAt?: { path: string; line: number } | null;
  /**
   * Report the file actually on screen, so the layout knows it.
   *
   * `initialPath` only says what the pane was *asked* to open. Opening a file
   * from the tree changes this pane's state and nothing else, so without this
   * the persisted layout keeps whatever was last requested through the palette
   * -- and popping the pane out reopens that stale file, or none at all.
   */
  onActivePathChange?: (path: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  /**
   * The toggle handler, via a ref.
   *
   * Monaco's listener is attached once on mount, so capturing the prop directly
   * would freeze the first render's copy -- the same shape the search debounce
   * and the palette opener both needed.
   */
  const onToggleBreakpointRef = useRef<(path: string, line: number) => void>(() => {});
  onToggleBreakpointRef.current = props.onToggleBreakpoint ?? (() => {});
  /** Monaco's handle for the breakpoint decorations, so they can be replaced. */
  const bpDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /** One Monaco model per file, so undo history survives tab switches. */
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());

  const [dir, setDir] = useState(props.cwd);
  /**
   * Listings by directory, for the whole visible tree.
   *
   * A missing key means "not fetched yet" rather than "empty", which is what
   * lets an expand render instantly and fill in when the read lands.
   */
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  /** Which directories are expanded. Paths, so it survives a re-listing. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  /** Right-click menu position and the entry it was opened on. */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  /** An inline text box in the tree: renaming an entry, or naming a new one. */
  const [editing, setEditing] = useState<
    { mode: "rename"; path: string; value: string }
    | { mode: "new-file" | "new-folder"; value: string }
    | null
  >(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  const active = files.find((f) => f.path === activePath) ?? null;

  /*
   * Tell the app which file is on screen.
   *
   * Held in a ref rather than listed as a dependency: the callback is a fresh
   * closure on every parent render, so depending on it directly would fire
   * this effect continuously instead of only when the file actually changes.
   */
  const onActivePathChangeRef = useRef(props.onActivePathChange);
  onActivePathChangeRef.current = props.onActivePathChange;
  useEffect(() => {
    onActivePathChangeRef.current?.(activePath);
  }, [activePath]);

  // ---- file tree ----------------------------------------------------------

  /** Fetch one directory's listing into the cache, replacing any previous. */
  const loadDir = useCallback(async (d: string) => {
    const entries = (await window.th.fileList(d)) as Entry[];
    setChildren((prev) => new Map(prev).set(d, entries));
    return entries;
  }, []);

  /**
   * Re-read every directory currently on screen.
   *
   * The watcher and every mutating action land here. Refreshing only the root
   * would leave an expanded subdirectory showing a file that has since been
   * renamed or deleted, and the editor's mtime guard would then reject the
   * next save with a conflict the user cannot see the cause of.
   */
  const refresh = useCallback(async () => {
    const dirs = [dir, ...open];
    const listings = await Promise.all(
      dirs.map(async (d) => [d, (await window.th.fileList(d)) as Entry[]] as const),
    );
    setChildren((prev) => {
      const next = new Map(prev);
      for (const [d, entries] of listings) next.set(d, entries);
      return next;
    });
  }, [dir, open]);

  /** Move the tree's root, discarding expansion state that no longer applies. */
  const rootTo = useCallback(async (d: string) => {
    setDir(d);
    setOpen(new Set());
    setChildren(new Map());
    await loadDir(d);
  }, [loadDir]);

  /**
   * Expand or collapse a directory, fetching its children on first open.
   *
   * The listing is kept after a collapse: reopening a directory is the common
   * motion, and a cached listing makes it instant. The watcher keeps it honest.
   */
  const toggleDir = useCallback(async (path: string) => {
    let opened = false;
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); opened = true; }
      return next;
    });
    if (opened && !children.has(path)) await loadDir(path);
  }, [children, loadDir]);

  useEffect(() => { void rootTo(props.cwd); }, [props.cwd, rootTo]);

  /**
   * Reveal the active file: expand every directory between the root and it.
   *
   * Without this the tree keeps showing wherever it was last navigated, so a
   * file opened from the palette, a diff hunk or a search hit appears in the
   * editor with no indication of where in the project it came from.
   *
   * A file outside the root is left alone rather than re-rooting the tree --
   * `ancestorsWithin` returns nothing for it. Opening something from another
   * worktree should not silently relocate the sidebar.
   */
  useEffect(() => {
    if (!activePath) return;
    const chain = ancestorsWithin(dir, activePath);
    if (chain.length === 0) return;

    setOpen((prev) => {
      // Only grow the set: collapsing what the user opened by hand would
      // undo their navigation every time a file opens.
      if (chain.every((d) => prev.has(d))) return prev;
      const next = new Set(prev);
      for (const d of chain) next.add(d);
      return next;
    });
    // Fetch whatever the newly-opened directories have not loaded. Awaiting
    // in sequence would stall the reveal on the deepest level.
    void Promise.all(chain.filter((d) => !children.has(d)).map(loadDir));
  }, [activePath, dir, children, loadDir]);

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

  /**
   * Open whatever Claude (or the app) asked for, including on a *later*
   * request into an already-mounted pane -- a mount-only initial path would
   * silently ignore every file after the first.
   */
  useEffect(() => {
    if (!props.initialPath) return;
    void (async () => {
      await openFile(props.initialPath!);
      const line = props.initialLine;
      if (!line) return;
      // The model is swapped in an effect, so reveal after it has landed.
      requestAnimationFrame(() => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      });
    })();
    // openNonce is in the deps so the same path can be reopened on demand.
  }, [props.initialPath, props.initialLine, props.openNonce, openFile]);

  /**
   * Diagnostics for the active file.
   *
   * Monaco checks TypeScript and JavaScript itself, but has no Python language
   * service at all -- a .py file looked clean no matter what was in it. ruff
   * fills that gap: fast enough to run on every save, and precise enough to
   * mark an exact range.
   */
  const lint = useCallback(async (path: string) => {
    const model = modelsRef.current.get(path);
    if (!model) return;
    const diags = (await window.th.lintCheck(path, props.cwd)) as {
      line: number; column: number; endLine: number; endColumn: number;
      message: string; code?: string; severity: "error" | "warning" | "info";
    }[];
    // The model may have been closed while ruff ran.
    if (model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      "fove-lint",
      diags.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
        message: d.code ? `${d.message} (${d.code})` : d.message,
        severity:
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [props.cwd]);

  // Check on open and after every save.
  useEffect(() => {
    if (activePath) void lint(activePath);
  }, [activePath, lint]);

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
      // Re-check after a save: the diagnostics the user just fixed should go.
      void lint(f.path);
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


  // ---- tree actions -------------------------------------------------------

  /** Report a failed operation beside the tree rather than swallowing it. */
  const runFs = useCallback(async (fn: () => Promise<unknown>) => {
    const r = (await fn()) as { ok: boolean; error?: string; path?: string };
    if (!r?.ok) setTreeError(r?.error ?? "operation failed");
    else setTreeError(null);
    await refresh();
    return r;
  }, [refresh]);

  /**
   * Rename, moving any open editor tab with the file.
   *
   * Monaco keys models by path, so without re-keying the map the editor keeps
   * writing to a path that no longer exists -- the save silently recreates the
   * old file.
   */
  const renameEntry = useCallback(async (from: string, name: string) => {
    const to = `${from.slice(0, from.lastIndexOf("/"))}/${name}`;
    const r = await runFs(() => window.th.fsRename(from, to));
    if (!r.ok) return;

    const model = modelsRef.current.get(from);
    if (model) {
      modelsRef.current.delete(from);
      modelsRef.current.set(to, model);
    }
    setFiles((prev) => prev.map((f) => (f.path === from ? { ...f, path: to, name } : f)));
    setActivePath((p) => (p === from ? to : p));
  }, [runFs]);

  /** Delete to the system trash, after confirming -- the tab goes too. */
  const trashEntry = useCallback(async (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!confirm(`Move "${name}" to the Trash?`)) return;
    const r = await runFs(() => window.th.fsTrash(path));
    if (r.ok) closeFile(path);
  }, [runFs, closeFile]);

  const copyText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  /** Build the menu for a tree entry. */
  const menuItems = useCallback((path: string, isDir: boolean): MenuItem[] => {
    const rel = path.startsWith(props.cwd) ? path.slice(props.cwd.length + 1) : path;
    return [
      { label: "New file…", onSelect: () => setEditing({ mode: "new-file", value: "" }) },
      { label: "New folder…", onSelect: () => setEditing({ mode: "new-folder", value: "" }) },
      {
        label: "Rename…",
        separated: true,
        onSelect: () =>
          setEditing({ mode: "rename", path, value: path.slice(path.lastIndexOf("/") + 1) }),
      },
      {
        label: "Duplicate",
        disabled: isDir,
        onSelect: () => void runFs(() => window.th.fsDuplicate(path)),
      },
      { label: "Copy path", separated: true, onSelect: () => copyText(path) },
      { label: "Copy relative path", onSelect: () => copyText(rel) },
      { label: "Reveal in Finder", onSelect: () => window.th.revealInFinder(path) },
      { label: "Open in VS Code", onSelect: () => window.th.openInEditor(path) },
      {
        label: "Move to Trash",
        separated: true,
        danger: true,
        onSelect: () => void trashEntry(path),
      },
    ];
  }, [props.cwd, runFs, copyText, trashEntry]);

  /** Commit whatever the inline box is for. */
  const commitEditing = useCallback(async () => {
    if (!editing) return;
    const name = editing.value.trim();
    setEditing(null);
    if (!name) return;
    if (editing.mode === "rename") await renameEntry(editing.path, name);
    else if (editing.mode === "new-file") await runFs(() => window.th.fsCreateFile(`${dir}/${name}`));
    else await runFs(() => window.th.fsCreateDir(`${dir}/${name}`));
  }, [editing, renameEntry, runFs, dir]);

  /**
   * Keep the tree live: an agent changing a file is the normal case here, and
   * a stale list also makes the editor's mtime guard reject the next save.
   *
   * Every expanded directory is watched, not just the root -- a file created
   * three levels down is exactly the case the tree is now able to show.
   */
  useEffect(() => {
    const watched = [dir, ...open];
    window.th.fsWatch(watched);
    const off = window.th.onFsChanged((changed) => {
      if (watched.includes(changed)) void refresh();
    });
    return off;
  }, [dir, open, refresh]);

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
      // Required for breakpoints: without it there is no gutter to click.
      glyphMargin: true,
    });
    editorRef.current = ed;

    /**
     * Report the selection to Claude Code.
     *
     * This is what makes "look at the highlighted code" work: without it
     * getCurrentSelection returns nothing and Claude has no idea what the user
     * is pointing at. Monaco fires on every cursor move, so the send is
     * debounced -- each one is a WebSocket notification to a live agent.
     */
    let selTimer: ReturnType<typeof setTimeout> | undefined;
    const reportSelection = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const model = ed.getModel();
        const sel = ed.getSelection();
        const path = model ? pathOfModel(modelsRef.current, model) : null;
        if (!model || !sel || !path) return;
        window.th.ideSelection({
          filePath: path,
          text: model.getValueInRange(sel),
          selection: {
            // Monaco counts lines from 1; the protocol counts from 0.
            start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
            end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
            isEmpty: sel.isEmpty(),
          },
        });
      }, 150);
    };
    /**
     * Toggle a breakpoint by clicking the glyph margin.
     *
     * Monaco reports the target type, so this fires only on the narrow gutter
     * strip -- clicking the line number or the code itself must not set one.
     */
    const onGutter = ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = ed.getModel();
      const path = model ? pathOfModel(modelsRef.current, model) : null;
      if (!line || !path) return;
      onToggleBreakpointRef.current(path, line);
    });

    const subs = [
      ed.onDidChangeCursorSelection(reportSelection),
      ed.onDidFocusEditorText(reportSelection),
      onGutter,
    ];

    return () => {
      clearTimeout(selTimer);
      for (const sub of subs) sub.dispose();
      ed.dispose();
      for (const m of modelsRef.current.values()) m.dispose();
      modelsRef.current.clear();
      editorRef.current = null;
    };
  }, []);

  /**
   * Draw breakpoints and the paused line for whichever file is showing.
   *
   * A decorations *collection* rather than `deltaDecorations`: it owns its own
   * ids, so replacing the set cannot leave an orphan marker behind when the
   * user switches files with a breakpoint set in each.
   */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!bpDecorationsRef.current) bpDecorationsRef.current = ed.createDecorationsCollection();

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const bp of props.breakpoints ?? []) {
      if (bp.path !== activePath) continue;
      decorations.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: "fove-breakpoint",
          glyphMarginHoverMessage: { value: "Breakpoint" },
          // Survives edits above it, so a breakpoint tracks its line.
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    if (props.pausedAt && props.pausedAt.path === activePath) {
      decorations.push({
        range: new monaco.Range(props.pausedAt.line, 1, props.pausedAt.line, 1),
        options: { isWholeLine: true, className: "fove-paused-line" },
      });
    }
    bpDecorationsRef.current.set(decorations);
  }, [props.breakpoints, props.pausedAt, activePath]);

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
  /** The visible tree, depth-first, following what is expanded. */
  const rows = flattenTree(dir, children, open);

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
          <div
            style={S.tree}
            onContextMenu={(ev) => {
              // Empty space acts on the directory being shown.
              if (ev.target !== ev.currentTarget) return;
              ev.preventDefault();
              setMenu({ x: ev.clientX, y: ev.clientY, path: dir, dir: true });
            }}
          >
            <div style={S.treePath} title={dir}>
              <button style={S.upBtn} onClick={() => void rootTo(parent)} title="Parent folder">↑</button>
              <span style={S.ellipsis}>{dir.split("/").pop() || "/"}</span>
            </div>
            {/* Naming a new file or folder happens in place, at the top. */}
            {editing && editing.mode !== "rename" && (
              <div style={S.treeRow}>
                <span style={{ width: 13 }}>{editing.mode === "new-folder" ? "▸" : "·"}</span>
                <input
                  autoFocus
                  style={S.inlineInput}
                  value={editing.value}
                  placeholder={editing.mode === "new-folder" ? "folder name" : "file name"}
                  onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                  onBlur={() => void commitEditing()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation(); // the app's shortcuts must not fire here
                    if (ev.key === "Enter") void commitEditing();
                    if (ev.key === "Escape") setEditing(null);
                  }}
                />
              </div>
            )}

            {rows.map((e) =>
              editing?.mode === "rename" && editing.path === e.path ? (
                <div key={e.path} style={{ ...S.treeRow, paddingLeft: indent(e.depth) }}>
                  <span style={{ width: 13 }}>{e.dir ? (e.open ? "▾" : "▸") : "·"}</span>
                  <input
                    autoFocus
                    style={S.inlineInput}
                    value={editing.value}
                    onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                    onBlur={() => void commitEditing()}
                    onKeyDown={(ev) => {
                      ev.stopPropagation();
                      if (ev.key === "Enter") void commitEditing();
                      if (ev.key === "Escape") setEditing(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  key={e.path}
                  onClick={() => (e.dir ? void toggleDir(e.path) : void openFile(e.path))}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setMenu({ x: ev.clientX, y: ev.clientY, path: e.path, dir: e.dir });
                  }}
                  style={{
                    ...S.treeRow,
                    paddingLeft: indent(e.depth),
                    color: e.path === activePath ? C.fg : e.dir ? C.dim : C.faint,
                    background: e.path === activePath ? "#1e2636" : undefined,
                  }}
                  title={e.path}
                >
                  <span style={{ width: 13 }}>{e.dir ? (e.open ? "▾" : "▸") : "·"}</span>
                  <span style={S.ellipsis}>{e.name}</span>
                </div>
              ),
            )}

            {treeError && <div style={S.treeError}>{treeError}</div>}
            {rows.length === 0 && <div style={S.treeEmpty}>empty</div>}
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.path, menu.dir)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Left padding for a row at `depth`.
 *
 * The tree is only 190px wide, so the step is small: deep paths need to stay
 * legible rather than run out of room for the filename.
 */
function indent(depth: number): number {
  return 8 + depth * 10;
}

const S: Record<string, React.CSSProperties> = {
  inlineInput: {
    flex: 1, minWidth: 0, background: "#0d0d11", color: C.fg,
    border: "1px solid #2f6feb", borderRadius: 3, padding: "0 4px",
    fontSize: 11, outline: "none", fontFamily: "inherit",
  },
  treeError: {
    margin: "4px 6px", padding: "4px 6px", borderRadius: 4,
    background: "#2a1214", border: "1px solid #6e2b30",
    color: "#ffb4b4", fontSize: 10, whiteSpace: "pre-wrap",
  },
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
