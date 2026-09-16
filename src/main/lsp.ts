/**
 * A language server, for the languages Monaco has no service of its own for.
 *
 * TypeScript needs nothing here -- Monaco ships the real TypeScript language
 * service and `renderer/ide/tsProject.ts` gives it the project to work on.
 * Python has nothing at all, which is why a `.py` file had no go-to-definition
 * and no find-references, and why this exists.
 *
 * Deliberately small. It speaks just enough LSP to start a server, keep it
 * told about the buffers that are open, and pass through the requests the
 * editor asks: definition, references, hover, rename. It is not a general
 * client and does not try to be -- no workspace folders beyond the one, no
 * file watching, no diagnostics. Diagnostics stay with `ruff` in lint.ts,
 * which already works and is instant.
 *
 * **A missing server is the normal case, not an error.** Most machines do not
 * have pyright installed and should not be told off about it: `available()`
 * answers null, the renderer registers nothing, and Python keeps working
 * exactly as well as it did before -- syntax highlighting, ruff diagnostics,
 * and the outline scanner.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ensureToolPath } from "./loginPath.js";

/**
 * Servers to try, best first.
 *
 * pyright is the one most Python projects are already checked by, so its
 * answers match what CI says. The others are worth trying because a machine
 * that has one of them has it for exactly this purpose.
 *
 * Exported so the dependency spec can be held to it: the doctor offers to
 * install the first server for a language, and a rename here that left
 * `shared/deps.ts` behind would have it install something this file never
 * looks for. test/deps.test.ts fails on that.
 */
export const SERVERS: Record<string, { bin: string; args: string[] }[]> = {
  python: [
    { bin: "pyright-langserver", args: ["--stdio"] },
    { bin: "basedpyright-langserver", args: ["--stdio"] },
    { bin: "jedi-language-server", args: [] },
    { bin: "pylsp", args: [] },
  ],
};

/** Give a server this long to answer `initialize` before giving up on it. */
const INIT_TIMEOUT_MS = 20_000;
/** And this long for any ordinary request, which should be far quicker. */
const REQUEST_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One server process, and the framing to talk to it.
 *
 * LSP over stdio is JSON-RPC in `Content-Length`-delimited frames. The reader
 * has to be a real incremental parser rather than a line splitter: a message
 * can arrive split across chunks, and several can arrive in one.
 */
class Server {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  /** Resolves once `initialize` has come back; requests queue behind it. */
  readonly ready: Promise<void>;
  private dead = false;

  constructor(
    bin: string,
    args: string[],
    private readonly root: string,
  ) {
    this.child = spawn(bin, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // A server's stderr is its own log. Swallowing it keeps a chatty server
    // from filling the app's console, and a fatal one still shows up as exit.
    this.child.stderr.resume();
    this.child.on("exit", () => this.die(new Error("language server exited")));
    this.child.on("error", (e) => this.die(e));

    this.ready = this.initialize();
  }

  private die(reason: Error): void {
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: the stream is out of sync and there is no
        // honest way back. Drop what we have rather than loop forever.
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const start = split + 4;
      if (this.buffer.length < start + length) return;

      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // Malformed JSON from a server is the server's bug; carry on reading
        // rather than tearing down a connection that may still work.
      }
    }
  }

  private dispatch(msg: {
    id?: number; method?: string; result?: unknown; error?: { message?: string };
  }): void {
    // A request *from* the server (workspace/configuration and friends).
    // Answering null is valid and is what a client with no settings says.
    if (msg.method && msg.id !== undefined) {
      this.write({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.id === undefined) return; // a notification; nothing here wants them

    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "language server error"));
    else p.resolve(msg.result ?? null);
  }

  private write(message: unknown): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method: string, params: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("language server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private async initialize(): Promise<void> {
    const uri = pathToFileURL(this.root).toString();
    await this.request("initialize", {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: this.root.split("/").pop() ?? "workspace" }],
      capabilities: {
        // Only what is actually asked for below. Claiming capabilities a
        // client does not implement makes a server do work for nobody.
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          definition: { linkSupport: false },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          rename: { prepareSupport: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    }, INIT_TIMEOUT_MS);
    this.notify("initialized", {});
  }

  stop(): void {
    if (this.dead) return;
    this.dead = true;
    // Ask, then insist: a server that ignores shutdown must not outlive the
    // app and keep a project's files open.
    try {
      this.notify("exit", {});
    } finally {
      this.child.kill();
    }
  }
}

export class LspService {
  /** One server per root and language. */
  private readonly servers = new Map<string, Server>();
  /** Which binary serves a language here, or null when none does. */
  private readonly resolved = new Map<string, { bin: string; args: string[] } | null>();

  /**
   * The server that would serve this language, or null if none is installed.
   *
   * Probed once. Installing a language server mid-session and expecting the
   * editor to notice is not a case worth paying a subprocess-per-check for.
   */
  async available(language: string): Promise<string | null> {
    const known = this.resolved.get(language);
    if (known !== undefined) return known?.bin ?? null;

    // A language server is installed per machine. Probing before the login
    // PATH is in place would conclude, permanently, that there is none.
    await ensureToolPath();

    for (const candidate of SERVERS[language] ?? []) {
      const ok = await new Promise<boolean>((resolve) => {
        execFile(candidate.bin, ["--version"], { timeout: 5000 }, (err) => {
          if (!err) return resolve(true);
          // A server that ran and objected to --version is still installed:
          // pyright-langserver exits 1 on it, wanting a transport flag. Only a
          // failed spawn (err.code is a string, "ENOENT") or a timeout kill
          // (err.code null, signal set) means there is no working binary.
          resolve(typeof err.code === "number");
        });
      });
      if (ok) {
        this.resolved.set(language, candidate);
        return candidate.bin;
      }
    }
    this.resolved.set(language, null);
    return null;
  }

  private async serverFor(root: string, language: string): Promise<Server | null> {
    const key = `${language} ${root}`;
    const running = this.servers.get(key);
    if (running) return running;

    if (!(await this.available(language))) return null;
    const spec = this.resolved.get(language);
    if (!spec) return null;

    const server = new Server(spec.bin, spec.args, root);
    this.servers.set(key, server);
    try {
      await server.ready;
    } catch {
      // A server that cannot start is a server we do not have. Forget it so a
      // later request can try again rather than reusing a dead process.
      this.servers.delete(key);
      server.stop();
      return null;
    }
    return server;
  }

  /**
   * Pass a request through, or resolve null when there is no server.
   *
   * Null rather than a rejection: "no language server" is not a failure the
   * editor should surface, it is a feature that is simply not present, and a
   * provider returning nothing is exactly how Monaco expects to hear it.
   */
  async request(
    root: string,
    language: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const server = await this.serverFor(root, language);
    if (!server) return null;
    try {
      return await server.request(method, params);
    } catch {
      return null;
    }
  }

  async notify(root: string, language: string, method: string, params: unknown): Promise<void> {
    const server = await this.serverFor(root, language);
    server?.notify(method, params);
  }

  /** Stop every server, on quit. */
  stopAll(): void {
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }
}
