/**
 * Make fove an IDE that Claude Code will connect to.
 *
 * Claude Code discovers editors by scanning ~/.claude/ide/<port>.lock, then
 * opening a WebSocket to 127.0.0.1:<port> and speaking JSON-RPC 2.0 with
 * MCP-shaped payloads. When it wants to show you a file or a diff, it calls a
 * tool on *us* -- so implementing these puts Claude's output in fove's editor
 * pane instead of the terminal or a separate VS Code window.
 *
 * ## Provenance of this contract
 *
 * This protocol is NOT documented by Anthropic. Every detail here was read off
 * Anthropic's own VS Code server ("Claude Code VSCode MCP" v2.1.251) by
 * connecting to it and calling `tools/list`, rather than copied from a
 * community write-up -- several of which have the argument names wrong
 * (`openDiff` really takes old_file_path/new_file_path/new_file_contents/
 * tab_name, not originalPath/modifiedContent).
 *
 * Because it is unversioned and unofficial, it is treated as best-effort: an
 * unknown method returns a JSON-RPC error instead of throwing, and nothing in
 * the app depends on Claude connecting.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWsServer, newAuthToken } from "./wsserver.js";

const IDE_DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "ide");

/** MCP tool results are content arrays; text is the only kind we return. */
const text = (s: string) => ({ content: [{ type: "text", text: s }] });

export interface IdeHooks {
  /** Show a file in the editor pane, optionally selecting a range. */
  openFile(req: {
    filePath: string;
    preview?: boolean;
    startText?: string;
    endText?: string;
    selectToEndOfLine?: boolean;
    makeFrontmost?: boolean;
  }): Promise<void> | void;
  /** Show a diff. Resolves when the user accepts or rejects it. */
  openDiff(req: {
    oldPath: string;
    newPath: string;
    newContents: string;
    tabName: string;
  }): Promise<"saved" | "rejected">;
  closeTab(tabName: string): Promise<void> | void;
  closeAllDiffTabs(): Promise<void> | void;
  /** Editors currently open in the app, newest first. */
  openEditors(): Promise<{ filePath: string; isDirty?: boolean }[]>;
  currentSelection(): Promise<Selection | null>;
  isDirty(filePath: string): Promise<boolean>;
  save(filePath: string): Promise<boolean>;
  workspaceFolders(): string[];
}

export interface Selection {
  filePath: string;
  text: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/** The tools Claude Code expects an IDE to expose, mirroring the VS Code server. */
const TOOLS = [
  {
    name: "openFile",
    description: "Open a file in the editor and optionally select a range",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to open" },
        preview: { type: "boolean", default: false },
        startText: { type: "string" },
        endText: { type: "string" },
        selectToEndOfLine: { type: "boolean", default: false },
        makeFrontmost: { type: "boolean", default: true },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
  {
    name: "openDiff",
    description: "Open a git diff for the file",
    inputSchema: {
      type: "object",
      properties: {
        old_file_path: { type: "string" },
        new_file_path: { type: "string" },
        new_file_contents: { type: "string" },
        tab_name: { type: "string" },
      },
      required: ["old_file_path", "new_file_path", "new_file_contents", "tab_name"],
      additionalProperties: false,
    },
  },
  { name: "close_tab", inputSchema: { type: "object", properties: { tab_name: { type: "string" } }, required: ["tab_name"], additionalProperties: false } },
  { name: "closeAllDiffTabs", description: "Close all diff tabs in the editor", inputSchema: { type: "object", properties: {} } },
  { name: "getOpenEditors", description: "Get list of currently open editors", inputSchema: { type: "object", properties: {} } },
  { name: "getWorkspaceFolders", description: "Get workspace folders", inputSchema: { type: "object", properties: {} } },
  { name: "getCurrentSelection", description: "Get the current selection", inputSchema: { type: "object", properties: {} } },
  { name: "getLatestSelection", description: "Get the most recent selection", inputSchema: { type: "object", properties: {} } },
  { name: "checkDocumentDirty", description: "Check if a document has unsaved changes", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"], additionalProperties: false } },
  { name: "saveDocument", description: "Save a document", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"], additionalProperties: false } },
] as const;

export class IdeService {
  private ws: ReturnType<typeof createWsServer> | null = null;
  private lockPath: string | null = null;
  private token = "";
  private lastSelection: Selection | null = null;
  port = 0;

  constructor(private readonly hooks: IdeHooks) {}

  /**
   * Start listening and advertise via a lock file.
   * Returns the port, or null when the server could not start -- the app runs
   * fine without IDE integration, so this never throws.
   */
  async start(): Promise<number | null> {
    if (this.ws) return this.port;
    this.token = newAuthToken();

    const ws = createWsServer({
      // Claude Code negotiates the "mcp" subprotocol and drops the connection
      // if the server does not confirm it.
      protocols: ["mcp"],
      // Claude presents the lock file's token in this header.
      authorize: (h) => h["x-claude-code-ide-authorization"] === this.token,
      onMessage: (conn, raw) => {
        let msg: Rpc;
        try {
          msg = JSON.parse(raw) as Rpc;
        } catch {
          return; // not our problem to police
        }
        void this.dispatch(msg).then((result) => {
          if (msg.id === undefined) return; // notification: no reply
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...result }));
        });
      },
    });

    try {
      // Port 0 lets the OS pick a free one, which is what the lock file records.
      this.port = await ws.listen(0);
    } catch {
      return null;
    }
    this.ws = ws;

    await mkdir(IDE_DIR, { recursive: true });
    await this.sweepStaleLocks();
    this.lockPath = join(IDE_DIR, `${this.port}.lock`);
    await writeFile(
      this.lockPath,
      JSON.stringify({
        pid: process.pid,
        workspaceFolders: this.hooks.workspaceFolders(),
        ideName: "fove",
        transport: "ws",
        runningInWindows: process.platform === "win32",
        authToken: this.token,
      }),
      { mode: 0o600 },
    );
    return this.port;
  }

/**
   * Remove lock files this app left behind when it did not exit cleanly.
   *
   * A crash (or a kill -9) skips `stop()`, and the stale file would advertise a
   * dead IDE that Claude offers and then fails to reach. Only fove's own locks
   * whose pid is gone are removed -- another editor's lock is never touched.
   */
  private async sweepStaleLocks(): Promise<void> {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      for (const name of await readdir(IDE_DIR)) {
        if (!name.endsWith(".lock")) continue;
        const path = join(IDE_DIR, name);
        try {
          const lock = JSON.parse(await readFile(path, "utf8")) as { ideName?: string; pid?: number };
          if (lock.ideName !== "fove" || typeof lock.pid !== "number") continue;
          // Signal 0 tests for existence without touching the process.
          try {
            process.kill(lock.pid, 0);
          } catch {
            await rm(path, { force: true });
          }
        } catch {
          continue; // unreadable or malformed: leave it alone
        }
      }
    } catch {
      // No directory yet, or unreadable -- nothing to sweep.
    }
  }

  /** The env a `claude` PTY needs so it prefers this app as its IDE. */
  env(): Record<string, string> {
    if (!this.port) return {};
    return { CLAUDE_CODE_SSE_PORT: String(this.port), ENABLE_IDE_INTEGRATION: "true" };
  }

  /** Tell Claude what the user just selected, so it can act on it. */
  notifySelection(sel: Selection | null): void {
    this.lastSelection = sel;
    if (!this.ws || !sel) return;
    this.ws.broadcast(JSON.stringify({
      jsonrpc: "2.0",
      method: "selection_changed",
      params: { text: sel.text, filePath: sel.filePath, fileUrl: `file://${sel.filePath}`, selection: sel.selection },
    }));
  }

  /** Rewrite the lock file when the set of open workspaces changes. */
  async updateWorkspaces(): Promise<void> {
    if (!this.lockPath) return;
    try {
      await writeFile(this.lockPath, JSON.stringify({
        pid: process.pid,
        workspaceFolders: this.hooks.workspaceFolders(),
        ideName: "fove",
        transport: "ws",
        runningInWindows: process.platform === "win32",
        authToken: this.token,
      }), { mode: 0o600 });
    } catch {
      // A missing lock directory just means no IDE integration this run.
    }
  }

  /** Remove the advertisement, so Claude does not offer a dead IDE. */
  async stop(): Promise<void> {
    if (this.lockPath) { await rm(this.lockPath, { force: true }).catch(() => {}); this.lockPath = null; }
    if (this.ws) { await this.ws.close(); this.ws = null; }
    this.port = 0;
  }

  private async dispatch(msg: Rpc): Promise<Record<string, unknown>> {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    try {
      switch (msg.method) {
        case "initialize":
          return {
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "fove IDE", version: "0.1.0" },
            },
          };
        case "notifications/initialized":
          return {};
        case "tools/list":
          return { result: { tools: TOOLS } };
        case "tools/call":
          return { result: await this.callTool(String(p.name ?? ""), (p.arguments ?? {}) as Record<string, unknown>) };
        default:
          return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
      }
    } catch (err) {
      return { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async callTool(name: string, a: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "openFile": {
        await this.hooks.openFile({
          filePath: String(a.filePath ?? ""),
          preview: a.preview === true,
          startText: typeof a.startText === "string" ? a.startText : undefined,
          endText: typeof a.endText === "string" ? a.endText : undefined,
          selectToEndOfLine: a.selectToEndOfLine === true,
          makeFrontmost: a.makeFrontmost !== false,
        });
        return text(`Opened file: ${String(a.filePath ?? "")}`);
      }
      case "openDiff": {
        // Blocking by design: Claude waits for the user's verdict on the diff.
        const verdict = await this.hooks.openDiff({
          oldPath: String(a.old_file_path ?? ""),
          newPath: String(a.new_file_path ?? ""),
          newContents: String(a.new_file_contents ?? ""),
          tabName: String(a.tab_name ?? ""),
        });
        return text(verdict === "saved" ? "FILE_SAVED" : "DIFF_REJECTED");
      }
      case "close_tab":
        await this.hooks.closeTab(String(a.tab_name ?? ""));
        return text("TAB_CLOSED");
      case "closeAllDiffTabs":
        await this.hooks.closeAllDiffTabs();
        return text("CLOSED_ALL_DIFF_TABS");
      case "getOpenEditors":
        return text(JSON.stringify({ tabs: await this.hooks.openEditors() }));
      case "getWorkspaceFolders": {
        const folders = this.hooks.workspaceFolders();
        return text(JSON.stringify({ folders, rootPath: folders[0] ?? null }));
      }
      case "getCurrentSelection": {
        const sel = await this.hooks.currentSelection();
        return text(JSON.stringify(sel ?? { success: false, message: "No active editor" }));
      }
      case "getLatestSelection":
        return text(JSON.stringify(this.lastSelection ?? { success: false, message: "No selection" }));
      case "checkDocumentDirty": {
        const dirty = await this.hooks.isDirty(String(a.filePath ?? ""));
        return text(JSON.stringify({ isDirty: dirty }));
      }
      case "saveDocument": {
        const ok = await this.hooks.save(String(a.filePath ?? ""));
        return text(ok ? "DOCUMENT_SAVED" : "SAVE_FAILED");
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
