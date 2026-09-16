/**
 * Editor pane: Monaco -- the same editor VS Code uses -- with a file tree.
 *
 * Deliberately not a vim surface: this is click-to-place-cursor, real syntax
 * highlighting, multi-cursor, find/replace, and ⌘S to save.
 *
 * Saves carry the mtime the file had when it was opened, so an agent editing
 * the same file underneath produces a visible conflict rather than a silent
 * overwrite.
 *
 * Two things a tab can be, and they are separated deliberately:
 *
 *   - a *document* is a file, its model and its undo history. It is what gets
 *     saved, and it exists once per path no matter how many views point at it.
 *   - a *tab* is a view of one: the file itself, or the file compared against
 *     a git revision.
 *
 * Keeping those apart is what lets a diff against the working tree be
 * editable and ⌘S-able rather than a read-only picture of one -- the diff's
 * right-hand side *is* the document, not a copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import jsonWorker from "../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker";
import cssWorker from "../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker";
import htmlWorker from "../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker";
import tsWorker from "../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import { C } from "../ui/Chrome.js";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu.js";
import { flattenTree, ancestorsWithin } from "../../shared/tree-rows.js";
import { breadcrumb, disambiguate, relativeTo } from "../../shared/editor-tabs.js";
import { lineChanges } from "../../shared/line-diff.js";
import { SCANNED_LANGUAGES, scanSymbols, type ScannedSymbol } from "../../shared/symbols.js";
import {
  claimNavigation, ensureEditorOpener, loadProject, modelFor, releaseModel,
  releaseNavigation, renameModel, type ProjectStatus,
} from "../ide/tsProject.js";
import { closeDocument, noteRoot, registerLspProviders } from "../ide/lspProviders.js";

/** A file the pane has open: its metadata. The text lives in a Monaco model. */
interface Doc {
  path: string;
  name: string;
  mtimeMs: number;
  language: string;
  readonly?: boolean;
  /** Why the file could not be read, when it could not be. */
  error?: string;
}

/** A view of a document: the file itself. */
interface FileTab {
  kind: "file";
  key: string;
  path: string;
}

/**
 * A view of a document against a git revision.
 *
 * `modRev` absent means the right-hand side is the working file -- live,
 * editable, savable. Set, it is a fixed revision and the whole tab is a
 * read-only picture of a change that already happened.
 */
interface DiffTab {
  kind: "diff";
  key: string;
  path: string;
  /** Left-hand revision. "" is the index, as `git show :path` spells it. */
  rev: string;
  revLabel: string;
  modRev?: string;
  modLabel: string;
  original: string;
  modified?: string;
  /** The file did not exist at `rev`, so this is an addition rather than a change. */
  added: boolean;
  loading: boolean;
}

type Tab = FileTab | DiffTab;

interface Entry { name: string; path: string; dir: boolean; size: number }

/** One line's last-touched-by, as `git blame --porcelain` reports it. */
interface BlameLine {
  hash: string;
  author: string;
  /** Epoch milliseconds. */
  when: number;
  line: number;
  summary: string;
}

/** A commit in a file's history. */
interface Commit {
  oid: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

/** How a diff tab is addressed, so asking for the same one twice reuses it. */
function diffKey(path: string, rev: string, modRev?: string): string {
  return `diff:${rev}..${modRev ?? ""}:${path}`;
}

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
      // The diff editor's own colours, which the base vs-dark theme tunes for
      // a lighter background than this one -- left as-is they wash out.
      "diffEditor.insertedTextBackground": "#1f7a3320",
      "diffEditor.removedTextBackground": "#f0505025",
      "diffEditor.insertedLineBackground": "#0e2a1680",
      "diffEditor.removedLineBackground": "#2d121480",
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

    /*
     * Change bars, in the strip between the glyph margin and the line
     * numbers. Three pixels wide and full height: the point is peripheral
     * vision -- you should see where you have been without reading anything.
     */
    .fove-change-add { border-left: 3px solid #3fb950; margin-left: 2px; }
    .fove-change-mod { border-left: 3px solid #2f6feb; margin-left: 2px; }
    /*
     * A deletion has no line of its own to mark, so it is drawn as a wedge
     * hanging under the line that closed over it.
     */
    .fove-change-del::after {
      content: "";
      position: absolute;
      bottom: -3px;
      left: 2px;
      border: 3px solid transparent;
      border-top-color: #f05055;
    }

    /*
     * Inline blame. Dim enough to ignore while reading code, which is most of
     * the time -- it is answering a question you have not asked yet.
     */
    .fove-blame { color: #46464f; font-style: italic; }
  `;
  document.head.appendChild(style);
  themeReady = true;
}

/**
 * Outline support for the languages Monaco does not cover.
 *
 * Registered once for the whole renderer rather than per pane: Monaco's
 * provider registry is global, and registering again for each editor pane
 * would return every symbol two or three times over.
 *
 * ⌘⇧O drives this. Monaco's own `editor.action.quickOutline` is what opens --
 * a real picker with filtering and symbol kinds -- so all that is missing for
 * a Python file is somebody to ask, which is this.
 */
let symbolsReady = false;
function ensureSymbolProviders(): void {
  if (symbolsReady) return;
  symbolsReady = true;

  const KINDS: Record<ScannedSymbol["kind"], monaco.languages.SymbolKind> = {
    class: monaco.languages.SymbolKind.Class,
    function: monaco.languages.SymbolKind.Function,
    method: monaco.languages.SymbolKind.Method,
    constant: monaco.languages.SymbolKind.Constant,
    struct: monaco.languages.SymbolKind.Struct,
    interface: monaco.languages.SymbolKind.Interface,
    enum: monaco.languages.SymbolKind.Enum,
    module: monaco.languages.SymbolKind.Module,
    trait: monaco.languages.SymbolKind.Interface,
  };

  const convert = (
    s: ScannedSymbol,
    model: monaco.editor.ITextModel,
  ): monaco.languages.DocumentSymbol => {
    const endLine = Math.min(Math.max(s.endLine, s.line), model.getLineCount());
    const full = new monaco.Range(s.line, 1, endLine, model.getLineMaxColumn(endLine));
    return {
      name: s.name,
      detail: s.detail ?? "",
      kind: KINDS[s.kind],
      tags: [],
      range: full,
      // What gets revealed on selection: the declaration, not the whole body.
      selectionRange: new monaco.Range(s.line, 1, s.line, model.getLineMaxColumn(s.line)),
      children: s.children.map((c) => convert(c, model)),
    };
  };

  for (const language of SCANNED_LANGUAGES) {
    monaco.languages.registerDocumentSymbolProvider(language, {
      displayName: "fove",
      provideDocumentSymbols(model) {
        return scanSymbols(language, model.getValue()).map((s) => convert(s, model));
      },
    });
  }
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
  /**
   * Open this file as a diff instead of as a file, e.g. from the git pane.
   * `rev` is the left-hand side; the right is the working file.
   */
  initialDiff?: { path: string; rev: string; revLabel?: string };
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
  const diffHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
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
  /** The same, for the git change bars. Separate so one cannot clear the other. */
  const changeDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /**
   * Each open file as HEAD has it, for the change bars.
   *
   * A ref rather than state: it is read by the recompute, which already runs
   * off a timer, and re-rendering the whole pane when a background read lands
   * would be a render per file opened for no visible reason.
   */
  const headTextRef = useRef<Map<string, string>>(new Map());
  /** Blame per file, and the decoration showing it on the cursor's line. */
  const blameRef = useRef<Map<string, BlameLine[]>>(new Map());
  const blameDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /** One Monaco model per *document*, so undo history survives tab switches. */
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  /** Models for the fixed sides of a diff, keyed by tab. Disposed with the tab. */
  const sideModelsRef = useRef<Map<string, monaco.editor.ITextModel[]>>(new Map());
  /**
   * The dirty-tracking subscription on each document's model.
   *
   * Held so it can be disposed with the tab. The models themselves can
   * outlive the tab -- the language service owns the project's -- so a
   * listener added on every open would otherwise stack up one per open.
   */
  const contentSubsRef = useRef<Map<string, monaco.IDisposable>>(new Map());

  const [dir, setDir] = useState(props.cwd);
  /** The repository root, for repo-relative paths and revisions. */
  const [root, setRoot] = useState<string | null>(null);
  /**
   * Listings by directory, for the whole visible tree.
   *
   * A missing key means "not fetched yet" rather than "empty", which is what
   * lets an expand render instantly and fill in when the read lands.
   */
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  /** Which directories are expanded. Paths, so it survives a re-listing. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<Map<string, Doc>>(new Map());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Paths with unsaved edits. Keyed by document, since a diff tab shares one. */
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  /** Side-by-side or inline, for every diff tab in this pane. */
  const [sideBySide, setSideBySide] = useState(true);
  /*
   * Format on save, remembered across restarts.
   *
   * In localStorage rather than the persisted layout: it is a preference about
   * how you work, not about how this pane is arranged, and it should hold for
   * every editor pane in every workspace rather than travelling with one of
   * them. On by default -- it does nothing at all unless the project itself
   * ships a formatter, so the default cannot surprise anyone's repository.
   */
  const [formatOnSave, setFormatOnSave] = useState(
    () => localStorage.getItem("fove.formatOnSave") !== "off",
  );
  useEffect(() => {
    localStorage.setItem("fove.formatOnSave", formatOnSave ? "on" : "off");
  }, [formatOnSave]);
  /** What the diff editor last computed, for the +/− counts in the crumb bar. */
  const [diffStats, setDiffStats] = useState<{ added: number; removed: number } | null>(null);
  /** Inline blame on the cursor's line. Off by default -- it is a lot of ink. */
  const [blameOn, setBlameOn] = useState(
    () => localStorage.getItem("fove.blame") === "on",
  );
  useEffect(() => {
    localStorage.setItem("fove.blame", blameOn ? "on" : "off");
  }, [blameOn]);
  /** Commits that touched the active file, or null while the list is closed. */
  const [history, setHistory] = useState<Commit[] | null>(null);
  /** What the language service was given, for the breadcrumb bar to report. */
  const [project, setProject] = useState<ProjectStatus | null>(null);
  /** Right-click menu position and the entry it was opened on. */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  /** An inline text box in the tree: renaming an entry, or naming a new one. */
  const [editing, setEditing] = useState<
    { mode: "rename"; path: string; value: string }
    | { mode: "new-file" | "new-folder"; value: string }
    | null
  >(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  /*
   * Mirrors of state for the callbacks that need to *read* it.
   *
   * Assigned during render rather than in an effect, so a callback created in
   * the same render already sees the current value. The alternative -- listing
   * `docs` and `tabs` as dependencies of every callback -- rebuilds them on
   * each keystroke and re-fires the effects that depend on them.
   */
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const historyRef = useRef(history);
  historyRef.current = history;
  const rootRef = useRef(root);
  rootRef.current = root;

  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const activeDoc = active ? docs.get(active.path) ?? null : null;
  const activeDirty = active ? dirty.has(active.path) : false;
  /** A diff against a fixed revision is history: there is nothing to save. */
  const activeEditable = !!active && (active.kind === "file" || !active.modRev);

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
    onActivePathChangeRef.current?.(active?.path ?? null);
  }, [active?.path]);

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

  /** The repository this pane is looking at, or null outside one. */
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await window.th.gitRoot(props.cwd);
      if (live) setRoot(r);
    })();
    return () => { live = false; };
  }, [props.cwd]);

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
  const activePath = active?.path ?? null;
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

  // ---- documents ----------------------------------------------------------

  /**
   * Make sure a path has a document and a model, reading it if it has not been.
   *
   * Idempotent, because both opening a file tab and opening a diff against the
   * working tree need the same document, and the diff must not get a second
   * model with its own undo stack.
   */
  const ensureDoc = useCallback(async (path: string): Promise<Doc> => {
    const known = docsRef.current.get(path);
    if (known) return known;

    const r = (await window.th.fileRead(path)) as {
      content?: string; mtimeMs?: number; readonly?: boolean; error?: string;
    };
    // Monaco's registry is authoritative; main's map is only a hint.
    const language = languageForPath(path);
    const doc: Doc = {
      path,
      name: path.split("/").pop() ?? path,
      mtimeMs: r.mtimeMs ?? 0,
      language,
      readonly: r.readonly,
      error: r.error,
    };

    // Two callers can race into the same file; the first model wins.
    if (!doc.error && !modelsRef.current.has(path)) {
      /*
       * Keyed by file URI, and shared with the language service's copy of the
       * project if it has already read this file. One model per path is what
       * makes editing a file and navigating to it agree with each other --
       * two models of the same path drift apart the moment you type.
       */
      const model = modelFor(path, language, r.content ?? "");
      contentSubsRef.current.get(path)?.dispose();
      contentSubsRef.current.set(path, model.onDidChangeContent(() => {
        setDirty((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
      }));
      modelsRef.current.set(path, model);
    }
    docsRef.current = new Map(docsRef.current).set(path, doc);
    setDocs(docsRef.current);
    return doc;
  }, []);

  /** Add a tab if it is not already there, and show it either way. */
  const showTab = useCallback((tab: Tab) => {
    setTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveKey(tab.key);
  }, []);

  const openFile = useCallback(async (path: string) => {
    const doc = await ensureDoc(path);
    showTab({ kind: "file", key: path, path });
    if (doc.error) setNotice(`${doc.name}: ${doc.error}`);
  }, [ensureDoc, showTab]);

  /**
   * Open a file as a diff against a revision.
   *
   * The right-hand side is the working file unless `modRev` names one, so the
   * common case -- reviewing what an agent just did -- is an editable diff you
   * can fix in place and save, not a picture you have to leave to act on.
   *
   * A file that did not exist at `rev` gets an empty original rather than an
   * error: that is what an addition *is*, and git's own diff renders it the
   * same way.
   */
  const openDiff = useCallback(async (
    path: string,
    rev: string,
    opts: { revLabel?: string; modRev?: string; modLabel?: string } = {},
  ) => {
    const key = diffKey(path, rev, opts.modRev);
    const revLabel = opts.revLabel ?? (rev === "" ? "index" : rev);
    const modLabel = opts.modLabel ?? (opts.modRev ? opts.modRev : "working tree");

    // Show the tab before the reads land, so the click feels immediate.
    showTab({
      kind: "diff", key, path, rev, revLabel,
      modRev: opts.modRev, modLabel,
      original: "", added: false, loading: true,
    });

    const rel = root ? relativeTo(root, path) : null;
    if (!rel || !root) {
      setTabs((prev) => prev.map((t) =>
        t.key === key && t.kind === "diff"
          ? { ...t, loading: false, original: "", added: true }
          : t));
      setNotice("not in this repository — showing the file as new");
      return;
    }

    // The working-tree side is a document; a fixed side is just text.
    const [original, modified] = await Promise.all([
      window.th.gitFileAt(root, rev, rel),
      opts.modRev !== undefined
        ? window.th.gitFileAt(root, opts.modRev, rel)
        : Promise.resolve(null),
    ]);
    if (opts.modRev === undefined) await ensureDoc(path);

    setTabs((prev) => prev.map((t) =>
      t.key === key && t.kind === "diff"
        ? {
            ...t,
            loading: false,
            original: original ?? "",
            added: original === null,
            modified: opts.modRev !== undefined ? modified ?? "" : undefined,
          }
        : t));
  }, [root, showTab, ensureDoc]);

  /**
   * Act on an open request from the app: a file, or a diff.
   *
   * Gated on the *nonce* rather than on the path, and that is not a detail.
   * This pane reports the file it is showing back into the layout, so that a
   * popped-out window reopens what you were looking at -- which means the
   * pane's own props change as a result of what it displays. Keying off the
   * path, a request that opened a *diff* tab came straight back as a request
   * to open that same path as a plain file, on top of the diff that was just
   * asked for. The nonce is the only thing here that means "this is new".
   *
   * A mount with no nonce still acts, which is what restores a persisted
   * file when the workspace reloads.
   */
  const handledNonce = useRef<number | null>(null);
  useEffect(() => {
    const nonce = props.openNonce ?? 0;
    if (handledNonce.current === nonce) return;

    const diff = props.initialDiff;
    if (diff) {
      // The revision read is repo-relative, so a request arriving before the
      // repository is known waits for it rather than failing.
      if (!root) return;
      handledNonce.current = nonce;
      void openDiff(diff.path, diff.rev, { revLabel: diff.revLabel });
      return;
    }

    if (!props.initialPath) return;
    handledNonce.current = nonce;
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
  }, [
    props.initialPath, props.initialLine, props.initialDiff, props.openNonce,
    root, openFile, openDiff,
  ]);

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

  /**
   * Format the buffer in place, before it is written.
   *
   * Applied as a Monaco edit rather than by replacing the model's value: an
   * edit keeps one undo step (⌘Z after a save undoes the formatting, not your
   * work) and lets the cursor be put back where it was. Replacing the value
   * outright resets both, which is how format-on-save earns its reputation.
   *
   * A formatter that fails says so and changes nothing -- a syntax error is
   * the common case, and the save must still happen.
   */
  const formatBuffer = useCallback(async (
    path: string,
    model: monaco.editor.ITextModel,
  ): Promise<void> => {
    const r = await window.th.formatRun(path, model.getValue(), props.cwd);
    if (r.error) { setNotice(`${r.by}: ${r.error}`); return; }
    if (r.content === null || model.isDisposed() || r.content === model.getValue()) return;

    const ed = editorRef.current;
    const position = ed?.getPosition() ?? null;
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: r.content }],
      () => null,
    );
    // The formatted text may be shorter than where the cursor was sitting.
    if (position && ed && ed.getModel() === model) {
      const lineNumber = Math.min(position.lineNumber, model.getLineCount());
      ed.setPosition({
        lineNumber,
        column: Math.min(position.column, model.getLineMaxColumn(lineNumber)),
      });
    }
  }, [props.cwd]);

  // ---- language service ---------------------------------------------------

  /**
   * Hand the project to Monaco's TypeScript service, so navigation reaches
   * past the open file.
   *
   * Keyed on the repository root rather than the pane's cwd: a pane opened on
   * `src/` is still working in the same program as one opened on the root,
   * and loading it twice under two names would double the memory for nothing.
   */
  useEffect(() => {
    const where = root ?? props.cwd;
    if (!where) return;
    let live = true;
    void loadProject(where).then((s) => {
      if (!live) return;
      setProject(s);
      // Only worth saying when it is not the whole truth.
      if (s.skipped > 0) {
        setNotice(`indexed ${s.files} files, skipped ${s.skipped}`);
        setTimeout(() => setNotice(null), 2600);
      }
    });
    return () => { live = false; };
  }, [root, props.cwd]);

  /**
   * A language server for whatever was just opened, if one is installed.
   *
   * Driven by the file you open rather than started up front: a Python server
   * indexes the whole project on start, and a session that never opens a
   * `.py` file should never pay for that.
   */
  useEffect(() => {
    const where = root ?? props.cwd;
    const language = activeDoc?.language;
    const path = activeDoc?.path;
    if (!where || !language || !path) return;

    // This pane's own working directory is the answer to "which repository is
    // this file in" -- the provider should never have to infer it from a path.
    noteRoot(path, where);

    /*
     * No `live` guard on the notice.
     *
     * There was one, and it was why this never said anything: the effect runs
     * first with the pane's cwd, then again the moment `gitRoot` resolves, and
     * the cleanup from that first run cancelled the notice it was about to
     * show. The second run then found the language already wired and said
     * nothing either. Registration is idempotent and the notice is about the
     * machine rather than about this render, so neither needs cancelling.
     */
    void registerLspProviders(where, language).then((server) => {
      if (!server) return;
      setNotice(`${language}: ${server}`);
      setTimeout(() => setNotice(null), 2200);
    });
  }, [root, props.cwd, activeDoc?.language, activeDoc?.path]);

  /**
   * Go-to-definition lands here.
   *
   * Monaco has no workspace of its own, so a definition in another file is a
   * request it hands back for somebody to fulfil. This pane fulfils it when
   * it is the one with the focus -- see `claimNavigation`.
   */
  const navigateTo = useCallback((path: string, line: number, column: number) => {
    void (async () => {
      await openFile(path);
      requestAnimationFrame(() => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column });
        ed.focus();
      });
    })();
  }, [openFile]);

  useEffect(() => {
    ensureEditorOpener();
    const ed = editorRef.current;
    if (!ed) return;
    // Claim on mount as well as on focus: a pane that opens and is
    // immediately navigated from should not need a click first.
    claimNavigation(navigateTo);
    const sub = ed.onDidFocusEditorText(() => claimNavigation(navigateTo));
    return () => {
      sub.dispose();
      releaseNavigation(navigateTo);
    };
  }, [navigateTo]);

  // ---- blame --------------------------------------------------------------

  /**
   * Who last touched the cursor's line, written at the end of it.
   *
   * Only the cursor's line, not every line: blaming the whole file turns the
   * right-hand half of the editor into a second column of text you have to
   * read past to read the code. One line follows where you are looking.
   *
   * Blame is indexed by the line numbers of the *committed* file, so once the
   * buffer is edited the mapping drifts. Rather than show a confident wrong
   * name, editing hides the annotation until the next save re-blames.
   */
  const paintBlame = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!blameDecorationsRef.current) {
      blameDecorationsRef.current = ed.createDecorationsCollection();
    }
    const model = ed.getModel();
    const path = model ? pathOfModel(modelsRef.current, model) : null;
    const lines = path ? blameRef.current.get(path) : undefined;
    const position = ed.getPosition();
    const stale = path ? dirtyRef.current.has(path) : true;

    if (!blameOn || !lines || !position || stale) {
      blameDecorationsRef.current.clear();
      return;
    }
    const hit = lines[position.lineNumber - 1];
    // A line added since the last commit has no blame entry, which is itself
    // the answer -- nothing is written rather than the neighbour's name.
    if (!hit || hit.line !== position.lineNumber) {
      blameDecorationsRef.current.clear();
      return;
    }

    const uncommitted = /^0+$/.test(hit.hash);
    const label = uncommitted
      ? "uncommitted"
      : `${hit.author} · ${ago(hit.when)} · ${hit.summary}`;
    blameDecorationsRef.current.set([{
      range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
      options: {
        isWholeLine: true,
        after: { content: `    ${label}`, inlineClassName: "fove-blame" },
      },
    }]);
  }, [blameOn]);

  const paintBlameRef = useRef(paintBlame);
  paintBlameRef.current = paintBlame;

  /**
   * Blame the active file, once it is asked for.
   *
   * `git blame` walks the whole history of a file, so it is not something to
   * run on every open -- only when the annotation is actually switched on.
   */
  const loadBlame = useCallback(async (path: string) => {
    if (!root) return;
    const rel = relativeTo(root, path);
    if (!rel) return;
    const lines = (await window.th.gitBlame(root, rel)) as BlameLine[];
    blameRef.current.set(path, lines);
    paintBlameRef.current();
  }, [root]);

  useEffect(() => {
    if (!blameOn || !activePath) { paintBlame(); return; }
    void loadBlame(activePath);
  }, [blameOn, activePath, loadBlame, paintBlame]);

  // ---- history ------------------------------------------------------------

  /** The commits that touched the active file, newest first. */
  const openHistory = useCallback(async () => {
    const path = tabsRef.current.find((t) => t.key === activeKey)?.path;
    if (!path || !root) return;
    const rel = relativeTo(root, path);
    if (!rel) { setNotice("not in this repository"); return; }
    setHistory([]);
    setHistory((await window.th.gitFileLog(root, rel, 100)) as Commit[]);
  }, [activeKey, root]);

  /**
   * Open one commit's own change to this file, as a diff tab.
   *
   * `<sha>^` against `<sha>` -- the same pair `git show` uses. A root commit
   * has no parent, so the left side reads as absent and the diff renders as
   * the addition it was. A commit from before a rename is the one case this
   * gets wrong: `--follow` finds it, but the path it knew the file by was a
   * different one, and the left side comes back empty.
   */
  const openCommitDiff = useCallback((path: string, c: Commit) => {
    setHistory(null);
    void openDiff(path, `${c.oid}^`, {
      revLabel: `${c.short}^`,
      modRev: c.oid,
      modLabel: c.short,
    });
  }, [openDiff]);

  const save = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.key === activeKey);
    // A diff against a fixed revision has no working file behind it.
    if (!tab || (tab.kind === "diff" && tab.modRev !== undefined)) return;
    const doc = docsRef.current.get(tab.path);
    const model = modelsRef.current.get(tab.path);
    if (!doc || !model || doc.readonly) return;

    if (formatOnSave) await formatBuffer(doc.path, model);

    const content = model.getValue();
    const r = (await window.th.fileWrite(doc.path, content, doc.mtimeMs)) as {
      ok: boolean; mtimeMs?: number; error?: string; conflict?: boolean;
    };
    if (r.ok) {
      docsRef.current = new Map(docsRef.current).set(doc.path, {
        ...doc, mtimeMs: r.mtimeMs ?? doc.mtimeMs,
      });
      setDocs(docsRef.current);
      setDirty((prev) => {
        if (!prev.has(doc.path)) return prev;
        const next = new Set(prev);
        next.delete(doc.path);
        return next;
      });
      setNotice(`saved ${doc.name}`);
      // Re-check after a save: the diagnostics the user just fixed should go.
      void lint(doc.path);
      // The change bars are computed from the buffer, so they were already
      // right; blame was suppressed while the buffer was dirty and now has a
      // clean file to index against again.
      if (blameOn) void loadBlame(doc.path);
      setTimeout(() => setNotice(null), 1600);
    } else {
      setNotice(r.conflict ? `${doc.name} changed on disk — reopen to merge` : `save failed: ${r.error}`);
    }
  }, [activeKey, lint, formatOnSave, formatBuffer, blameOn, loadBlame]);

  /**
   * Close a tab, and the document behind it once no tab still points at it.
   *
   * Disposing the model with the tab would throw away undo history that a
   * second view of the same file is still using -- close the diff, and the
   * file tab beside it would lose everything you had typed.
   */
  const closeTab = useCallback((key: string) => {
    for (const m of sideModelsRef.current.get(key) ?? []) m.dispose();
    sideModelsRef.current.delete(key);

    setTabs((prev) => {
      const closed = prev.find((t) => t.key === key);
      const rest = prev.filter((t) => t.key !== key);
      if (closed && !rest.some((t) => t.path === closed.path)) {
        const model = modelsRef.current.get(closed.path);
        contentSubsRef.current.get(closed.path)?.dispose();
        contentSubsRef.current.delete(closed.path);
        // A language server holds an in-memory copy of every buffer it has
        // been told about; closing the tab is when it should go back to
        // reading the file from disk like any other.
        const language = docsRef.current.get(closed.path)?.language;
        const where = rootRef.current ?? props.cwd;
        if (language && where) closeDocument(where, language, closed.path);
        // Hand the file back to the language service as plain text before the
        // buffer goes, so closing a tab does not remove it from the program.
        if (model) releaseModel(closed.path, model.getValue());
        modelsRef.current.delete(closed.path);
        docsRef.current = new Map(docsRef.current);
        docsRef.current.delete(closed.path);
        setDocs(docsRef.current);
      }
      setActiveKey((cur) => (cur === key ? rest[rest.length - 1]?.key ?? null : cur));
      return rest;
    });
  }, []);

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
   * Rename, moving any open tab with the file.
   *
   * Monaco keys models by path, so without re-keying the map the editor keeps
   * writing to a path that no longer exists -- the save silently recreates the
   * old file.
   */
  const renameEntry = useCallback(async (from: string, name: string) => {
    const to = `${from.slice(0, from.lastIndexOf("/"))}/${name}`;
    const r = await runFs(() => window.th.fsRename(from, to));
    if (!r.ok) return;

    /*
     * Rebuild the buffer at the new path rather than re-keying the map.
     *
     * A model's URI cannot change, and the URI is what the language service
     * resolves imports against -- re-keying alone left a model claiming to be
     * a file that no longer exists.
     */
    const doc = docsRef.current.get(from);
    if (modelsRef.current.has(from)) {
      const moved = renameModel(from, to, doc?.language ?? languageForPath(to));
      contentSubsRef.current.get(from)?.dispose();
      contentSubsRef.current.delete(from);
      modelsRef.current.delete(from);
      if (moved) {
        modelsRef.current.set(to, moved);
        contentSubsRef.current.set(to, moved.onDidChangeContent(() => {
          setDirty((prev) => (prev.has(to) ? prev : new Set(prev).add(to)));
        }));
      }
    }
    if (doc) {
      docsRef.current = new Map(docsRef.current);
      docsRef.current.delete(from);
      docsRef.current.set(to, { ...doc, path: to, name });
      setDocs(docsRef.current);
    }
    setDirty((prev) => {
      if (!prev.has(from)) return prev;
      const next = new Set(prev);
      next.delete(from);
      next.add(to);
      return next;
    });
    // Anything cached under the old path is about a file that no longer
    // exists. Dropped rather than moved: both are re-read on demand, and a
    // blame indexed against the old name would be quietly wrong.
    headTextRef.current.delete(from);
    blameRef.current.delete(from);

    // A file tab is keyed by its path, so the key moves with it; a diff tab's
    // key embeds the revision it was taken against and keeps its own shape.
    setTabs((prev) => prev.map((t) => {
      if (t.path !== from) return t;
      if (t.kind === "file") {
        setActiveKey((k) => (k === from ? to : k));
        return { ...t, key: to, path: to };
      }
      // The diff's cached side models are keyed by the tab key, which just
      // moved -- rebuild them under the new one rather than orphaning them.
      const nextKey = diffKey(to, t.rev, t.modRev);
      const sides = sideModelsRef.current.get(t.key);
      if (sides) {
        sideModelsRef.current.delete(t.key);
        sideModelsRef.current.set(nextKey, sides);
      }
      setActiveKey((k) => (k === t.key ? nextKey : k));
      return { ...t, key: nextKey, path: to };
    }));
  }, [runFs]);

  /** Delete to the system trash, after confirming -- the tabs go too. */
  const trashEntry = useCallback(async (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!confirm(`Move "${name}" to the Trash?`)) return;
    const r = await runFs(() => window.th.fsTrash(path));
    if (!r.ok) return;
    for (const t of tabsRef.current.filter((x) => x.path === path)) closeTab(t.key);
  }, [runFs, closeTab]);

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
      {
        label: "Diff against HEAD",
        separated: true,
        disabled: isDir || !root,
        onSelect: () => void openDiff(path, "HEAD"),
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
  }, [props.cwd, runFs, copyText, trashEntry, openDiff, root]);

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
    ensureSymbolProviders();
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

    /*
     * Repaint the change bars as you type.
     *
     * Debounced, and generously: the diff is cheap on the common edit but the
     * gutter is peripheral information -- nobody is waiting on it, and paying
     * for it on every keystroke would be paying for nothing.
     */
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const repaintSoon = () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => paintChangesRef.current(), 250);
    };

    const subs = [
      ed.onDidChangeCursorSelection(reportSelection),
      ed.onDidFocusEditorText(reportSelection),
      // Blame follows the cursor, so it is repainted on every move. Cheap:
      // the data is already in memory and it is one decoration.
      ed.onDidChangeCursorPosition(() => paintBlameRef.current()),
      ed.onDidChangeModelContent(repaintSoon),
      // A tab switch is a model swap, and the bars belong to the file rather
      // than to the editor -- without this they stay on the previous file's.
      ed.onDidChangeModel(() => { paintChangesRef.current(); paintBlameRef.current(); }),
      onGutter,
    ];

    return () => {
      clearTimeout(selTimer);
      clearTimeout(changeTimer);
      for (const sub of subs) sub.dispose();
      // Detach first: the diff editor shares these models, and disposing one
      // out from under it leaves it holding a disposed model.
      diffRef.current?.setModel(null);
      diffRef.current?.dispose();
      diffRef.current = null;
      ed.dispose();
      // Same rule as closing a tab: the project's models belong to the
      // language service, not to this pane, and a second editor pane is
      // probably still using them.
      for (const sub of contentSubsRef.current.values()) sub.dispose();
      contentSubsRef.current.clear();
      for (const [path, m] of modelsRef.current) releaseModel(path, m.getValue());
      modelsRef.current.clear();
      for (const models of sideModelsRef.current.values()) for (const m of models) m.dispose();
      sideModelsRef.current.clear();
      editorRef.current = null;
    };
  }, []);

  /**
   * The diff editor, built the first time one is actually asked for.
   *
   * Monaco's diff editor is two code editors and a worker-backed comparison,
   * so a pane that never shows a diff should not pay for one.
   */
  const ensureDiffEditor = useCallback((): monaco.editor.IStandaloneDiffEditor | null => {
    if (diffRef.current) return diffRef.current;
    const host = diffHostRef.current;
    if (!host) return null;
    ensureTheme();
    const d = monaco.editor.createDiffEditor(host, {
      theme: "th-dark",
      automaticLayout: true,
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      // The left side is a revision that has already happened; only the
      // working-tree side is anyone's to edit.
      originalEditable: false,
      renderOverviewRuler: false,
    });
    d.onDidUpdateDiff(() => {
      const changes = d.getLineChanges() ?? [];
      let added = 0;
      let removed = 0;
      for (const c of changes) {
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
      setDiffStats({ added, removed });
    });
    diffRef.current = d;
    return d;
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
    // A diff tab empties the code editor. There is nothing to decorate, and
    // the breakpoints belong to the file, not to the editor showing it.
    if (!ed.getModel()) { bpDecorationsRef.current.clear(); return; }

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

  /**
   * Draw the git change bars for whatever the code editor is showing.
   *
   * Against HEAD rather than against the index: the question the gutter
   * answers is "what have I changed since the last commit", and staging is
   * not an answer to it -- a staged line is still a line you changed.
   */
  const paintChanges = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!changeDecorationsRef.current) {
      changeDecorationsRef.current = ed.createDecorationsCollection();
    }
    const model = ed.getModel();
    const path = model ? pathOfModel(modelsRef.current, model) : null;
    const head = path ? headTextRef.current.get(path) : undefined;
    // No model, or no revision to compare against: an untracked file has
    // nothing at HEAD, and marking all of it would be a solid bar saying
    // something you already know from the tab.
    if (!model || head === undefined) {
      changeDecorationsRef.current.clear();
      return;
    }

    const changes = lineChanges(head, model.getValue());
    const lineCount = model.getLineCount();
    const at = (line: number, className: string, hover?: string) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: false,
        linesDecorationsClassName: className,
        ...(hover ? { linesDecorationsTooltip: hover } : {}),
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const line of changes.added) {
      if (line <= lineCount) decorations.push(at(line, "fove-change-add"));
    }
    for (const line of changes.modified) {
      if (line <= lineCount) decorations.push(at(line, "fove-change-mod"));
    }
    for (const d of changes.deleted) {
      // A deletion above line 1 has no line of its own to hang under, so it
      // is drawn on line 1 instead of being dropped.
      const line = Math.min(Math.max(d.line, 1), lineCount);
      const preview = d.text.slice(0, 12).join("\n");
      decorations.push(at(
        line,
        "fove-change-del",
        `${d.text.length} line${d.text.length === 1 ? "" : "s"} removed:\n${preview}`,
      ));
    }
    changeDecorationsRef.current.set(decorations);
  }, []);

  /** For the mount-time listeners, which cannot see later renders' closures. */
  const paintChangesRef = useRef(paintChanges);
  paintChangesRef.current = paintChanges;

  /**
   * Read a file as HEAD has it, so the bars have something to compare to.
   *
   * Re-read rather than cached forever: a commit, a checkout or a stash all
   * move HEAD underneath an open file, and bars against a revision that is no
   * longer current are worse than none.
   */
  const loadHead = useCallback(async (path: string) => {
    if (!root) return;
    const rel = relativeTo(root, path);
    if (!rel) return;
    const text = await window.th.gitFileAt(root, "HEAD", rel);
    if (text === null) headTextRef.current.delete(path);
    else headTextRef.current.set(path, text);
    paintChangesRef.current();
  }, [root]);

  /*
   * On open, and then slowly.
   *
   * HEAD moves without this pane hearing about it -- a commit from the git
   * pane, a checkout in a terminal, an agent rebasing -- and the file watcher
   * says nothing about any of them. Fifteen seconds is far below the rate
   * anyone notices staleness in a gutter bar, and one `git show` at that
   * interval is nothing beside the git pane's own three-second status poll.
   */
  useEffect(() => {
    if (!activePath) return;
    void loadHead(activePath);
    const t = setInterval(() => void loadHead(activePath), 15_000);
    return () => clearInterval(t);
  }, [activePath, loadHead]);

  /**
   * Point whichever editor the active tab needs at the right models.
   *
   * Only one of the two ever holds a model at a time. A document's model can
   * legally live in both, but then both render it and both fight over the
   * scroll position -- so the one that is not on screen is emptied first.
   */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;

    if (!active || active.kind === "file") {
      diffRef.current?.setModel(null);
      const model = active ? modelsRef.current.get(active.path) ?? null : null;
      ed.setModel(model);
      ed.updateOptions({ readOnly: !!activeDoc?.readonly });
      if (model) ed.focus();
      setDiffStats(null);
      return;
    }

    ed.setModel(null);
    if (active.loading) return;
    const d = ensureDiffEditor();
    if (!d) return;

    /*
     * Fixed sides get their own models, cached per tab so switching away and
     * back does not rebuild them -- and so closing the tab knows exactly what
     * to dispose. The working-tree side is the document's own model, never a
     * copy, which is what keeps the diff editable and savable.
     */
    let sides = sideModelsRef.current.get(active.key);
    if (!sides) {
      sides = [monaco.editor.createModel(active.original, languageForPath(active.path))];
      if (active.modified !== undefined) {
        sides.push(monaco.editor.createModel(active.modified, languageForPath(active.path)));
      }
      sideModelsRef.current.set(active.key, sides);
    }
    const modified = active.modRev !== undefined
      ? sides[1] ?? null
      : modelsRef.current.get(active.path) ?? null;
    if (!modified) return;

    d.setModel({ original: sides[0]!, modified });
    d.updateOptions({
      renderSideBySide: sideBySide,
      readOnly: active.modRev !== undefined || !!activeDoc?.readonly,
    });
    d.layout();
    d.getModifiedEditor().focus();
  }, [active, activeDoc?.readonly, sideBySide, ensureDiffEditor]);

  /**
   * Shortcuts that belong to this pane, and only while it has the focus.
   *
   * Registered in the capture phase so they run before the app's own window
   * handler and can stop it: ⌘⇧O is the app's second way into Spotlight
   * everywhere else, and inside an editor it has to mean what it means in
   * every other editor -- go to a symbol in this file.
   */
  useEffect(() => {
    const focused = () =>
      !!hostRef.current?.closest("[data-pane]")?.contains(document.activeElement);

    const onKey = (e: KeyboardEvent) => {
      // Escape closes the history sheet, and must not reach anything else
      // while it is open -- it is the only modal thing this pane has.
      if (e.key === "Escape" && historyRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setHistory(null);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || !focused()) return;

      if (e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
        return;
      }

      if (e.key === "O" || (e.key === "o" && e.shiftKey)) {
        // A diff tab's right-hand editor is the one showing the file.
        const target = diffRef.current && editorRef.current?.getModel() === null
          ? diffRef.current.getModifiedEditor()
          : editorRef.current;
        const action = target?.getAction("editor.action.quickOutline");
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        void action.run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  const parent = dir.replace(/\/[^/]+$/, "") || "/";
  /** The visible tree, depth-first, following what is expanded. */
  const rows = flattenTree(dir, children, open);

  /**
   * Tab labels, grown leftwards only where two tabs would otherwise read the
   * same. Recomputed from the open set rather than stored, so closing the
   * colliding tab shortens the survivor's label again.
   */
  const labels = useMemo(() => disambiguate(tabs.map((t) => t.path)), [tabs]);
  const crumbs = useMemo(
    () => (activePath ? breadcrumb(root ?? props.cwd, activePath) : []),
    [activePath, root, props.cwd],
  );

  return (
    <div style={S.pane}>
      <div style={S.toolbar}>
        <button style={S.glyphBtn} onClick={() => setTreeOpen((v) => !v)} title="Toggle file tree">
          {treeOpen ? "◧" : "▢"}
        </button>
        <div style={S.tabs}>
          {tabs.map((t) => (
            <div
              key={t.key}
              onClick={() => setActiveKey(t.key)}
              style={{ ...S.tab, ...(t.key === activeKey ? S.tabActive : null) }}
              title={t.kind === "diff" ? `${t.path} — ${t.revLabel} ↔ ${t.modLabel}` : t.path}
            >
              {t.kind === "diff" && <span style={S.tabGlyph}>⇄</span>}
              <span>
                {labels.get(t.path) ?? t.path}
                {dirty.has(t.path) && (t.kind === "file" || !t.modRev) ? " •" : ""}
              </span>
              <button
                style={S.tabClose}
                onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {notice && <span style={S.notice}>{notice}</span>}
        <button
          style={{ ...S.glyphBtn, opacity: activeDirty && activeEditable ? 1 : 0.4 }}
          onClick={() => void save()}
          title="Save (⌘S)"
          disabled={!activeDirty || !activeEditable}
        >
          ⤓
        </button>
        {active && (
          <button
            style={S.glyphBtn}
            onClick={() => window.th.openInEditor(active.path)}
            title="Open in VS Code"
          >
            ↗
          </button>
        )}
      </div>

      {/*
        * The path, in full, without hovering anything.
        *
        * A tab strip of basenames answers "which file is this" only when you
        * already know the project by heart; the breadcrumb answers it at a
        * glance, and each segment is a way back into the tree.
        */}
      {active && (
        <div style={S.crumbs}>
          {crumbs.map((c) => (
            <span key={c.path} style={S.crumbWrap}>
              <button
                style={{ ...S.crumb, color: c.leaf ? C.fg : C.dim }}
                title={c.leaf ? "Copy path" : `Reveal ${c.name} in the tree`}
                onClick={() => {
                  if (c.leaf) { copyText(c.path); setNotice("path copied"); setTimeout(() => setNotice(null), 1200); }
                  else { setOpen((prev) => new Set(prev).add(c.path)); void loadDir(c.path); setTreeOpen(true); }
                }}
              >
                {c.name}
              </button>
              {!c.leaf && <span style={S.crumbSep}>›</span>}
            </span>
          ))}

          <span style={{ flex: 1 }} />

          {active.kind === "diff" && (
            <>
              <span style={S.revPill} title="Left side">{active.revLabel}</span>
              <span style={S.crumbSep}>↔</span>
              <span style={S.revPill} title="Right side">{active.modLabel}</span>
              {active.added && <span style={S.addedPill}>new file</span>}
              {diffStats && (
                <>
                  <span style={{ color: "#3fb950" }}>+{diffStats.added}</span>
                  <span style={{ color: "#f05055" }}>−{diffStats.removed}</span>
                </>
              )}
              {/*
                * The glyph shows the layout you would switch *to*, not the
                * one you are in -- a button says what it does.
                */}
              <button
                style={S.glyphBtn}
                onClick={() => setSideBySide((v) => !v)}
                title={sideBySide ? "Switch to inline" : "Switch to side-by-side"}
              >
                {sideBySide ? "▤" : "▥"}
              </button>
              <button
                style={S.glyphBtn}
                onClick={() => void openFile(active.path)}
                title="Open the file itself"
              >
                ⊡
              </button>
            </>
          )}
          {active.kind === "file" && root && (
            <button
              style={S.glyphBtn}
              onClick={() => void openDiff(active.path, "HEAD")}
              title="Diff this file against HEAD"
            >
              ⇄
            </button>
          )}
          {root && (
            <>
              <button
                style={{ ...S.glyphBtn, color: blameOn ? C.fg : C.faint }}
                onClick={() => setBlameOn((v) => !v)}
                title={
                  blameOn
                    ? "Blame is on — who last touched the cursor's line"
                    : "Blame: who last touched the cursor's line"
                }
              >
                ◉
              </button>
              <button
                style={S.glyphBtn}
                onClick={() => void openHistory()}
                title="Commits that touched this file"
              >
                ⟲
              </button>
            </>
          )}
          {activeEditable && (
            <button
              style={{ ...S.glyphBtn, color: formatOnSave ? C.fg : C.faint }}
              onClick={() => setFormatOnSave((v) => !v)}
              title={
                formatOnSave
                  ? "Format on save is on — uses the project's own prettier or ruff, and does nothing if it has neither"
                  : "Format on save is off"
              }
            >
              ≡
            </button>
          )}
        </div>
      )}

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
          {/*
            * Both editors stay mounted and one is hidden, rather than being
            * created and torn down per tab: Monaco's construction cost is real
            * and switching between a file and its diff is a frequent motion.
            */}
          <div
            ref={hostRef}
            style={{ ...S.host, display: active?.kind === "diff" ? "none" : "block" }}
          />
          <div
            ref={diffHostRef}
            style={{ ...S.host, display: active?.kind === "diff" ? "block" : "none" }}
          />
          {!active && <div style={S.empty}>select a file from the tree</div>}
          {active?.kind === "diff" && active.loading && (
            <div style={S.empty}>reading {active.revLabel}…</div>
          )}
          {activeDoc?.error && active?.kind === "file" && (
            <div style={S.empty}>{activeDoc.name}: {activeDoc.error}</div>
          )}
        </div>
      </div>

      {/*
        * File history, as a sheet under the breadcrumb it was opened from.
        *
        * Deliberately not a pane: it is a list you read once to pick a commit
        * off, and giving it a pane would mean rearranging the workspace to
        * ask a question and rearranging it back afterwards.
        */}
      {history && active && (
        <>
          <div style={S.scrim} onClick={() => setHistory(null)} />
          <div style={S.history}>
            <div style={S.historyHead}>
              <span>history of {active.path.split("/").pop()}</span>
              <span style={{ flex: 1 }} />
              <button style={S.glyphBtn} onClick={() => setHistory(null)} title="Close (esc)">✕</button>
            </div>
            {history.length === 0 && <div style={S.historyEmpty}>reading…</div>}
            {history.map((c) => (
              <div
                key={c.oid}
                style={S.historyRow}
                onClick={() => openCommitDiff(active.path, c)}
                title={`${c.oid}\n${c.subject}`}
              >
                <span style={S.sha}>{c.short}</span>
                <span style={S.ellipsis}>{c.subject}</span>
                <span style={S.historyMeta}>{c.author}</span>
                <span style={S.historyMeta}>{c.when}</span>
              </div>
            ))}
          </div>
        </>
      )}

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
 * A coarse "how long ago", for blame.
 *
 * Deliberately coarse: the difference between 14 and 16 days changes nothing
 * about how you read a line, and a precise timestamp is longer to read for an
 * annotation that is meant to be glanced at.
 */
function ago(when: number): string {
  const days = Math.floor((Date.now() - when) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
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
  // `position: relative` so the history sheet is placed against the pane
  // rather than against whatever ancestor happens to be positioned.
  pane: { display: "flex", flexDirection: "column", height: "100%", position: "relative",
          background: "#0d0d11", color: C.fg, fontFamily: "system-ui", fontSize: 12,
          overflow: "hidden" },
  scrim: { position: "absolute", inset: 0, zIndex: 20 },
  history: {
    position: "absolute", top: 48, right: 8, zIndex: 21,
    width: "min(560px, calc(100% - 16px))", maxHeight: "70%", overflowY: "auto",
    background: "#14141a", border: `1px solid ${C.line}`, borderRadius: 6,
    boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
  },
  historyHead: {
    display: "flex", alignItems: "center", gap: 8, padding: "6px 9px",
    borderBottom: `1px solid ${C.line}`, color: C.dim,
    position: "sticky", top: 0, background: "#14141a",
  },
  historyRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "3px 9px",
    cursor: "pointer", lineHeight: "18px",
  },
  historyMeta: { color: C.faint, fontSize: 11, flexShrink: 0 },
  historyEmpty: { color: C.faint, padding: "8px 9px", fontSize: 11 },
  sha: { fontFamily: 'Menlo, "SF Mono", monospace', color: "#d29922", fontSize: 11, flexShrink: 0 },
  toolbar: { display: "flex", alignItems: "center", gap: 4, padding: "3px 7px",
             background: "#14141a", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
             minHeight: 26 },
  tabs: { display: "flex", gap: 2, overflowX: "auto", maxWidth: "60%" },
  tab: { display: "flex", alignItems: "center", gap: 5, padding: "2px 7px",
         borderRadius: 4, color: C.faint, cursor: "pointer", whiteSpace: "nowrap",
         border: "1px solid transparent" },
  tabActive: { background: "#1e2636", color: C.fg, border: `1px solid ${C.line}` },
  tabGlyph: { color: "#d29922", fontSize: 10 },
  tabClose: { background: "transparent", border: "none", color: C.faint,
              cursor: "pointer", fontSize: 9, padding: 0, lineHeight: 1 },
  iconBtn: { background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
             borderRadius: 4, padding: "1px 7px", cursor: "pointer", fontSize: 11 },
  /*
   * A button whose label is a single glyph.
   *
   * Fixed width, because these sit in a row that toggles: a ▥ that becomes a
   * ▤ must not shift everything beside it, and a word-width button would.
   * Slightly larger than the text buttons since a glyph at 11px is a smudge,
   * and every one of them carries a `title` -- a symbol nobody can name is
   * only an improvement if hovering it still answers the question.
   */
  glyphBtn: {
    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
    borderRadius: 4, padding: 0, width: 22, height: 17, lineHeight: "15px",
    cursor: "pointer", fontSize: 12, flexShrink: 0, textAlign: "center",
  },
  notice: { color: C.dim, fontSize: 11, marginRight: 4 },
  /*
   * One line, never two: the breadcrumb is a glance, and a wrapping one would
   * shove the editor down every time a deep file opened.
   */
  crumbs: {
    display: "flex", alignItems: "center", gap: 4, padding: "2px 8px",
    background: "#101017", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
    minHeight: 21, overflowX: "auto", whiteSpace: "nowrap", fontSize: 11,
  },
  crumbWrap: { display: "inline-flex", alignItems: "center", gap: 4 },
  crumb: {
    background: "transparent", border: "none", padding: 0, cursor: "pointer",
    fontSize: 11, fontFamily: "inherit",
  },
  crumbSep: { color: "#3a3a44" },
  revPill: {
    color: C.dim, background: "#191922", border: `1px solid ${C.line}`,
    borderRadius: 3, padding: "0 5px", fontSize: 10,
  },
  addedPill: { color: "#3fb950", fontSize: 10 },
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
  host: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center",
           justifyContent: "center", color: "#33333c", fontSize: 11,
           pointerEvents: "none", background: "#0d0d11" },
};
