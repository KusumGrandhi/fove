/**
 * Monaco providers backed by a language server.
 *
 * Monaco's provider interfaces and LSP say almost the same things in almost
 * the same shapes, and this is the "almost": positions are 1-based here and
 * 0-based there, a document is a model here and a URI there, and a server has
 * to be told what is in a buffer before it can answer a question about it.
 *
 * Four capabilities are wired, and they are the four that make an editor
 * navigable: definition, references, hover, rename. Completion is deliberately
 * left out -- it fires on every keystroke and a slow or half-configured server
 * would make typing feel broken, which is a much worse failure than a missing
 * feature. Diagnostics are left to `ruff` in main, which is instant and
 * already there.
 *
 * Nothing is registered when no server is installed, so a machine without
 * pyright behaves exactly as it did before rather than showing dead menu
 * items that never return anything.
 */

import * as monaco from "monaco-editor";

/** LSP's wire shapes, narrowed to the parts used. */
interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspLocationLink { targetUri: string; targetSelectionRange: LspRange; targetRange: LspRange }
interface LspHover { contents: unknown; range?: LspRange }
interface LspWorkspaceEdit { changes?: Record<string, { range: LspRange; newText: string }[]> }

/** Languages already wired, so a second editor pane does not double them up. */
const registered = new Set<string>();

/**
 * Which workspace each open file belongs to.
 *
 * Monaco's provider registry is global -- one definition provider per language
 * for the whole page -- but fove's tabs are workspaces, several repositories
 * open at once in a single renderer. So the provider cannot close over "the"
 * root, and it must not have to guess one either.
 *
 * It does not have to: the pane that opened the file already knows, because
 * that is its own working directory. It says so here, and the provider looks
 * the answer up. No path matching, no heuristics -- the repository a file came
 * from is a fact the app has, not one to be inferred from the path.
 */
const rootOfPath = new Map<string, string>();

/** The pane telling us which repository a file it just opened belongs to. */
export function noteRoot(path: string, root: string): void {
  rootOfPath.set(path, root);
}

/**
 * Buffers a server has been told about, and the version it last heard.
 *
 * Keyed by root as well as URI: the same file reached through two workspaces
 * is two servers, and one of them not having been told is the whole bug this
 * is here to avoid.
 */
const synced = new Map<string, number>();
const syncKey = (root: string, uri: string): string => `${root}\n${uri}`;

const toLspPosition = (p: monaco.IPosition): LspPosition => ({
  // Monaco counts lines and columns from 1; LSP counts from 0.
  line: p.lineNumber - 1,
  character: p.column - 1,
});

const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

/**
 * An LSP file URI back to a path Monaco can open.
 *
 * Servers spell file URIs inconsistently -- percent-encoding, and a drive
 * letter's case on Windows -- so this goes through the URL parser rather than
 * slicing off a `file://` prefix by hand.
 */
function uriToPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

const pathToUri = (path: string): string =>
  `file://${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Tell the server what is in a buffer before asking about it.
 *
 * A language server reads the project from disk itself, so it already knows
 * every file that has not been touched. What it cannot know is the buffer you
 * are editing right now -- and that is precisely the one the cursor is in, so
 * without this every answer is against the version on disk and lands on the
 * wrong line the moment anything is unsaved.
 */
async function sync(
  root: string,
  language: string,
  model: monaco.editor.ITextModel,
): Promise<string> {
  const path = model.uri.path;
  const uri = pathToUri(path);
  const version = model.getVersionId();
  const known = synced.get(syncKey(root, uri));

  /*
   * Awaited, not fired and forgotten. The request that follows is about this
   * buffer, and a server that has not been told about it yet answers null --
   * which looks exactly like "no definition here" and is why Cmd-click can
   * appear to do nothing at all.
   *
   * `synced` is only updated once the notification has landed, so a failed
   * one is re-sent next time rather than remembered as done.
   */
  if (known === undefined) {
    await window.th.lspNotify(root, language, "textDocument/didOpen", {
      textDocument: { uri, languageId: language, version, text: model.getValue() },
    });
  } else if (known !== version) {
    // Full-text sync. Incremental sync would mean tracking and translating
    // every edit; the whole-buffer form is what every server must accept and
    // the files involved are source files, not databases.
    await window.th.lspNotify(root, language, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
  }
  synced.set(syncKey(root, uri), version);
  return uri;
}

/** `Location | Location[] | LocationLink[] | null`, as servers variously reply. */
function toLocations(result: unknown): monaco.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: monaco.languages.Location[] = [];
  for (const item of list) {
    const link = item as Partial<LspLocationLink>;
    const loc = item as Partial<LspLocation>;
    if (link.targetUri && (link.targetSelectionRange ?? link.targetRange)) {
      out.push({
        uri: monaco.Uri.file(uriToPath(link.targetUri)),
        range: toMonacoRange((link.targetSelectionRange ?? link.targetRange)!),
      });
    } else if (loc.uri && loc.range) {
      out.push({
        uri: monaco.Uri.file(uriToPath(loc.uri)),
        range: toMonacoRange(loc.range),
      });
    }
  }
  return out;
}

/** Hover contents come as a string, a marked string, or a list of either. */
function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
  const obj = contents as { value?: string; language?: string } | null;
  if (!obj?.value) return "";
  return obj.language ? `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` : obj.value;
}

/**
 * Wire a language up, if a server for it is installed.
 *
 * Resolves to the server's name when something was registered, and null when
 * there was nothing to register -- which the caller reports as "no language
 * server" rather than as a failure.
 */
export async function registerLspProviders(
  root: string,
  language: string,
): Promise<string | null> {
  const server = await window.th.lspAvailable(language);
  if (!server) return null;

  /*
   * Report the server every time, not only the first.
   *
   * This used to return null once a language was wired, which collapsed three
   * different outcomes -- "no server on this machine", "already wired", and
   * "wired just now" -- into one silent answer. Combined with the caller's own
   * race (the effect re-runs the moment `gitRoot` resolves, cancelling the
   * first run's notice) the result was a feature that never said anything at
   * all, whether it worked or not. Saying which server is serving costs one
   * toast and is the difference between "it is on" and four rounds of guessing.
   */
  if (registered.has(language)) return server;
  registered.add(language);

  const ask = async (
    method: string,
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> => {
    // The pane that opened this file said which repository it came from.
    const where = rootOfPath.get(model.uri.path) ?? root;
    const uri = await sync(where, language, model);
    return window.th.lspRequest(where, language, method, {
      textDocument: { uri },
      position: toLspPosition(position),
      ...extra,
    });
  };

  monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      return toLocations(await ask("textDocument/definition", model, position));
    },
  });

  monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position, context) {
      return toLocations(await ask("textDocument/references", model, position, {
        context: { includeDeclaration: context.includeDeclaration },
      }));
    },
  });

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const r = (await ask("textDocument/hover", model, position)) as LspHover | null;
      const value = r ? hoverText(r.contents) : "";
      if (!value) return null;
      return {
        contents: [{ value }],
        ...(r?.range ? { range: toMonacoRange(r.range) } : {}),
      };
    },
  });

  monaco.languages.registerRenameProvider(language, {
    async provideRenameEdits(model, position, newName) {
      const r = (await ask("textDocument/rename", model, position, { newName })) as
        LspWorkspaceEdit | null;
      const changes = r?.changes;
      if (!changes) {
        // A rejection has to say why: Monaco shows this to the user, and an
        // empty edit would silently look like the rename worked.
        return { edits: [], rejectReason: "the language server could not rename this" };
      }
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      for (const [uri, list] of Object.entries(changes)) {
        for (const e of list) {
          edits.push({
            resource: monaco.Uri.file(uriToPath(uri)),
            versionId: undefined,
            textEdit: { range: toMonacoRange(e.range), text: e.newText },
          });
        }
      }
      return { edits };
    },
  });

  return server;
}

/** Forget a buffer the server was told about, when its tab closes. */
export function closeDocument(root: string, language: string, path: string): void {
  const uri = pathToUri(path);
  const where = rootOfPath.get(path) ?? root;
  rootOfPath.delete(path);
  if (!synced.delete(syncKey(where, uri))) return;
  // Nothing waits on a close, so this one really is fire-and-forget.
  void window.th.lspNotify(where, language, "textDocument/didClose", {
    textDocument: { uri },
  });
}
