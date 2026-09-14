/**
 * Giving Monaco's TypeScript service a whole project to think about.
 *
 * Monaco's language service builds its program out of the models that exist
 * in the renderer. That is the entire trick here and it is worth stating
 * plainly, because everything else follows from it:
 *
 *   **a model with no URI is a file with no name**, and a file with no name
 *   cannot be the target of an import.
 *
 * Models were being created as `createModel(text, language)` -- no URI -- so
 * every file was an island. `./git.js` resolved to nothing, go-to-definition
 * had nowhere to go, and find-references could only ever find the references
 * in the file you were already looking at.
 *
 * Creating them as `createModel(text, language, Uri.file(path))` and loading
 * the rest of the project alongside turns that same service into the one VS
 * Code ships: definitions, references, rename, and hover types that know what
 * the other file says.
 *
 * The cost is honest and bounded: one read of the project's text at startup
 * (capped in main), and the memory to hold it. The alternative -- a language
 * server subprocess and a protocol to it -- buys nothing here that this does
 * not, for TypeScript specifically, because the service is already running.
 */

import * as monaco from "monaco-editor";
/*
 * The TypeScript language service's own API.
 *
 * Monaco 0.56 moved it out of `monaco.languages.typescript` to a top-level
 * export; the old path is still there but now types as `{ deprecated: true }`,
 * so reaching for it fails at compile time rather than at runtime.
 */
import { typescript as ts } from "monaco-editor";

/** What the project load settled on, for the pane to report. */
export interface ProjectStatus {
  root: string;
  files: number;
  skipped: number;
  /** Semantic errors are only trustworthy once the program is complete. */
  semantic: boolean;
}

/** One load per root, and never twice: the worker keeps what it is given. */
const loaded = new Map<string, Promise<ProjectStatus>>();

/**
 * The project's files, as *extra libs* rather than as models.
 *
 * This distinction cost a debugging session and is worth writing down. Both
 * routes put a file into the language service's program, but a model is a
 * live editable buffer with listeners attached to it -- and creating one per
 * project file made Monaco's own leak detector fire on startup, hundreds of
 * `potential listener LEAK detected` exceptions deep, because the language
 * configuration service subscribes once per model.
 *
 * An extra lib is what the service actually wants for a file nobody is
 * looking at: text and a path, no buffer, no listeners. A model is created
 * only when a file is opened in a tab, which is bounded by what a person can
 * actually have open.
 *
 * Kept per path so that opening a file can hand the model over cleanly: the
 * same path must not be in the program twice.
 */
const extraLibs = new Map<string, { dispose(): void }>();
/** The text an extra lib held, so closing its tab can put it back. */
const extraLibText = new Map<string, string>();

function addExtraLib(path: string, content: string): void {
  const uri = monaco.Uri.file(path).toString();
  extraLibs.get(path)?.dispose();
  // Both services: a `.js` model is served by the JavaScript worker and a
  // `.ts` model by the TypeScript one, and a project is usually a mix.
  const subs = [
    ts.typescriptDefaults.addExtraLib(content, uri),
    ts.javascriptDefaults.addExtraLib(content, uri),
  ];
  extraLibs.set(path, { dispose: () => { for (const s of subs) s.dispose(); } });
  extraLibText.set(path, content);
}

/** Whether a path is part of the program this module loaded. */
export function isProjectFile(path: string): boolean {
  return extraLibText.has(path);
}

/**
 * The model for a path, created if it does not exist yet.
 *
 * Taking over from the extra lib rather than sitting beside it: the same file
 * present twice in one program is a program where every symbol has two
 * declarations, and find-references would report each one twice.
 */
export function modelFor(
  path: string,
  language: string,
  content: string,
): monaco.editor.ITextModel {
  extraLibs.get(path)?.dispose();
  extraLibs.delete(path);
  claims.set(path, (claims.get(path) ?? 0) + 1);

  const uri = monaco.Uri.file(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    // Another pane already has it open. That model is the live buffer and
    // wins over a fresh read -- overwriting it would discard unsaved edits.
    return existing;
  }
  return monaco.editor.createModel(content, language, uri);
}

/**
 * How many panes are holding a file's buffer open.
 *
 * Models are shared -- two editor panes showing the same file show the same
 * model, which is what makes an edit in one appear in the other. That also
 * means neither of them may dispose it on the way out, so disposal happens
 * here, when the last claim is given up.
 */
const claims = new Map<string, number>();

/**
 * Give up one pane's claim on a file, and its buffer once nobody holds it.
 *
 * The file then goes back to the program as plain text. Without that last
 * part, closing a tab would remove the file from the language service
 * entirely -- and "find all references" would quietly stop finding the ones
 * in a file you happened to have opened and closed, which is a bug nobody
 * would ever connect to closing a tab.
 */
/**
 * Move a file's buffer to a new path.
 *
 * A Monaco model's URI is fixed for its lifetime, so this rebuilds it rather
 * than renaming it. That matters now that models carry file URIs at all:
 * without it a renamed file kept a model whose URI named a path that no
 * longer exists, the language service went on resolving imports to the old
 * name, and opening the new path built a *second* model for the same file.
 *
 * The cost is the undo history, which cannot survive a new model. Monaco
 * offers no way to keep it, and a stale URI is the worse of the two.
 */
export function renameModel(
  from: string,
  to: string,
  language: string,
): monaco.editor.ITextModel | null {
  const old = monaco.editor.getModel(monaco.Uri.file(from));
  if (!old) return null;
  const text = old.getValue();

  const claimed = claims.get(from) ?? 0;
  claims.delete(from);
  extraLibs.get(from)?.dispose();
  extraLibs.delete(from);
  const wasProjectFile = extraLibText.delete(from);
  old.dispose();

  const next = monaco.editor.createModel(text, language, monaco.Uri.file(to));
  if (claimed > 0) claims.set(to, claimed);
  // Still the project's file, under its new name -- so closing its tab hands
  // it back to the language service at the path it now has.
  if (wasProjectFile) extraLibText.set(to, text);
  return next;
}

export function releaseModel(path: string, finalText: string): void {
  const left = (claims.get(path) ?? 1) - 1;
  if (left > 0) { claims.set(path, left); return; }
  claims.delete(path);

  monaco.editor.getModel(monaco.Uri.file(path))?.dispose();
  if (extraLibText.has(path)) addExtraLib(path, finalText);
}

/**
 * Map a project's tsconfig onto the compiler options Monaco understands.
 *
 * Only the options that change whether code *resolves* -- `paths`, `jsx`,
 * `baseUrl`, `strict`. The rest of a tsconfig is about emit, and Monaco emits
 * nothing.
 *
 * Unparseable or absent config is not an error: the defaults below are a
 * reasonable modern project, and they are what a JavaScript project with no
 * tsconfig at all should get anyway.
 */
function compilerOptions(raw: unknown): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    strict: true,
    // The project is loaded as real files; without this the service also
    // wants a lib.d.ts of its own on disk.
    noEmit: true,
  };

  const opts = (raw as { compilerOptions?: Record<string, unknown> } | null)?.compilerOptions;
  if (!opts) return base;

  if (typeof opts.strict === "boolean") base.strict = opts.strict;
  if (typeof opts.baseUrl === "string") base.baseUrl = opts.baseUrl;
  if (opts.paths && typeof opts.paths === "object") {
    base.paths = opts.paths as Record<string, string[]>;
  }
  if (typeof opts.jsx === "string") {
    const jsx = opts.jsx.toLowerCase();
    base.jsx = jsx === "preserve" ? ts.JsxEmit.Preserve
      : jsx === "react" ? ts.JsxEmit.React
      : jsx === "react-native" ? ts.JsxEmit.ReactNative
      : ts.JsxEmit.ReactJSX;
  }
  if (typeof opts.experimentalDecorators === "boolean") {
    base.experimentalDecorators = opts.experimentalDecorators;
  }
  return base;
}

/**
 * Strip comments from a tsconfig before parsing it.
 *
 * tsconfig is JSON with comments by convention and by TypeScript's own
 * parser, and nearly every real one has them -- `JSON.parse` on a commented
 * tsconfig throws, which would silently drop the project's `paths` and leave
 * every aliased import unresolved.
 */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
      m.startsWith('"') ? m : "")
    // Trailing commas, which tsconfig also tolerates.
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Load a project into the TypeScript service, once.
 *
 * Returns the same promise for repeated calls, so several editor panes
 * opening at the same time cost one read rather than one each.
 */
export function loadProject(root: string): Promise<ProjectStatus> {
  const already = loaded.get(root);
  if (already) return already;

  const p = (async (): Promise<ProjectStatus> => {
    const { files, skipped, hasTsConfig, tsconfig } = await window.th.projectSources(root);

    const options = compilerOptions(tsconfig ? parseJsonc(tsconfig.text) : null);
    for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      defaults.setCompilerOptions(options);
      defaults.setEagerModelSync(true);
    }

    for (const f of files) {
      // A file already open in a tab owns itself; its model is the live text
      // and must not be shadowed by the copy that was on disk at load.
      if (monaco.editor.getModel(monaco.Uri.file(f.path))) {
        extraLibText.set(f.path, f.content);
        continue;
      }
      addExtraLib(f.path, f.content);
    }

    /*
     * Semantic diagnostics only for a project that actually declares itself.
     *
     * A loose pile of JavaScript has no tsconfig, no declared dependencies
     * and no expectation of type-checking -- reporting "Cannot find module"
     * across all of it would be a red editor for someone who did nothing
     * wrong. Syntax errors are always real, so those stay on.
     */
    for (const defaults of [
      ts.typescriptDefaults,
      ts.javascriptDefaults,
    ]) {
      defaults.setDiagnosticsOptions({
        noSyntaxValidation: false,
        noSemanticValidation: !hasTsConfig,
        noSuggestionDiagnostics: true,
      });
    }

    return { root, files: files.length, skipped, semantic: hasTsConfig };
  })();

  loaded.set(root, p);
  return p;
}

/**
 * Where go-to-definition should send the user.
 *
 * Monaco's standalone editor cannot open a file on its own -- it has no
 * concept of a workspace -- so without an opener, jumping to a definition in
 * another file does nothing at all and looks like the feature is broken.
 *
 * The opener is global (one registry for the whole page) but there can be
 * several editor panes, so the most recently focused one claims it. That is
 * the one the user is looking at, which is where the definition should land.
 */
let openInFocusedPane: ((path: string, line: number, column: number) => void) | null = null;

export function claimNavigation(
  open: (path: string, line: number, column: number) => void,
): void {
  openInFocusedPane = open;
}

/** Release the claim if this pane still holds it, e.g. on unmount. */
export function releaseNavigation(
  open: (path: string, line: number, column: number) => void,
): void {
  if (openInFocusedPane === open) openInFocusedPane = null;
}

let openerRegistered = false;
export function ensureEditorOpener(): void {
  if (openerRegistered) return;
  openerRegistered = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file" || !openInFocusedPane) return false;
      const at = selectionOrPosition as { startLineNumber?: number; lineNumber?: number; startColumn?: number; column?: number } | undefined;
      const line = at?.startLineNumber ?? at?.lineNumber ?? 1;
      const column = at?.startColumn ?? at?.column ?? 1;
      openInFocusedPane(resource.path, line, column);
      // True means "handled": Monaco stops here rather than falling back to
      // its own no-op and leaving the click looking dead.
      return true;
    },
  });
}
