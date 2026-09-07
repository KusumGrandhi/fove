/**
 * Python debugging, over debugpy.
 *
 * Python-only in this round, deliberately: `core` is Flask, so that is the code
 * actually stepped through. Node speaks CDP rather than DAP and needs a bridge
 * or `vscode-js-debug` as an adapter -- roughly double the transport work for
 * the language debugged less here.
 *
 * ## How the adapter is started
 *
 * `python -m debugpy --listen <port> --wait-for-client ...` starts the program
 * paused and listening. fove connects a TCP socket and speaks DAP over it. Port
 * 0 is not usable here -- debugpy needs the port up front -- so one is chosen
 * by binding and releasing, which is a small race the alternative (parsing
 * debugpy's stdout) does not avoid either.
 *
 * ## The sequence that matters
 *
 * Observed against debugpy 1.8.21 rather than taken from the spec, because the
 * spec does not make the ordering obvious and getting it wrong produces a
 * session that connects and then does nothing:
 *
 *   initialize
 *     -> attach                 (send, but do NOT await its response)
 *     -> wait for the `initialized` EVENT
 *     -> setBreakpoints
 *     -> configurationDone
 *     -> only now does `attach` answer, and the program runs
 *
 * Three ways this fails silently, all of them seen:
 *   - Awaiting the `attach` response before configuring deadlocks: debugpy
 *     answers it only after `configurationDone`, which the client has not sent
 *     yet. The first version did this and failed with "attach timed out".
 *   - Breakpoints sent before `initialized` are dropped with no error.
 *   - A missing `configurationDone` leaves the program paused at startup,
 *     which is indistinguishable from a hang.
 *
 * A fake adapter cannot catch the first of those -- it replies immediately --
 * which is the argument for having tested against the real thing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { DapClient } from "./dapClient.js";
import { resolveConfig, type LaunchConfig } from "../shared/launch-config.js";

export interface Breakpoint {
  path: string;
  /** 1-based, as both DAP and Monaco count. */
  line: number;
}

export interface StackFrame {
  id: number;
  name: string;
  path?: string;
  line: number;
  column: number;
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** Non-zero when the value can be expanded into children. */
  variablesReference: number;
}

export type DebugState = "starting" | "running" | "paused" | "terminated";

export interface DebugStatus {
  state: DebugState;
  /** Why the program stopped: "breakpoint", "step", "exception", ... */
  reason?: string;
  threadId?: number;
  error?: string;
}

/** Ask the OS for a free port by binding one and letting it go. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** Wait for debugpy to accept connections, which is not instant. */
async function connectWithRetry(port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "connection refused";
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (err) {
      lastError = (err as Error).message;
      if (Date.now() > deadline) throw new Error(`could not reach debugpy: ${lastError}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

/**
 * Build the debugpy command line for a launch config.
 *
 * Pure, so the argument order -- which is easy to get wrong and produces a
 * baffling failure -- is testable without spawning anything.
 */
export function debugpyArgs(config: LaunchConfig, port: number): string[] {
  const args = [
    // debugpy warns on startup that frozen modules "may make the debugger miss
    // breakpoints" and asks for exactly this flag. A debugger that silently
    // skips a breakpoint is worse than one that fails loudly, so it is passed
    // rather than left to chance. Interpreter flag, so it precedes -m.
    "-Xfrozen_modules=off",
    "-m", "debugpy", "--listen", `127.0.0.1:${port}`, "--wait-for-client",
  ];
  // `-m flask` and a script path are alternatives; module wins, as VS Code does.
  if (config.module) args.push("-m", config.module);
  else if (config.program) args.push(config.program);
  // Everything after the target belongs to the program, not to debugpy.
  return [...args, ...(config.args ?? [])];
}

export class DebugSession {
  private client: DapClient | null = null;
  private socket: Socket | null = null;
  private child: ChildProcess | null = null;
  private status: DebugStatus = { state: "starting" };
  /** Breakpoints per file, so a change to one file does not clear the others. */
  private readonly breakpoints = new Map<string, number[]>();

  constructor(
    private readonly onStatus: (status: DebugStatus) => void,
    /** Program output, so stdout is visible without a separate terminal. */
    private readonly onOutput: (text: string, category: string) => void,
  ) {}

  get state(): DebugState {
    return this.status.state;
  }

  /**
   * Launch a program under debugpy and attach.
   *
   * Returns an error string rather than throwing: every failure here is
   * something to show in the pane (debugpy missing, port taken, program
   * exited immediately), not an exception to unwind through.
   */
  async start(opts: {
    config: LaunchConfig;
    cwd: string;
    python: string;
    breakpoints?: Breakpoint[];
  }): Promise<{ ok: boolean; error?: string }> {
    if (this.client) return { ok: false, error: "a debug session is already running" };

    const config = resolveConfig(opts.config, { workspaceFolder: opts.cwd });
    let port: number;
    try {
      port = await freePort();
    } catch {
      return { ok: false, error: "could not find a free port" };
    }

    this.setStatus({ state: "starting" });

    const child = spawn(opts.python, debugpyArgs(config, port), {
      cwd: config.cwd ?? opts.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
    });
    this.child = child;

    // debugpy reports "No module named debugpy" on stderr and exits; without
    // surfacing this the pane would just say "could not reach debugpy".
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      stderr += text;
      this.onOutput(text, "stderr");
    });
    child.stdout?.on("data", (b: Buffer) => this.onOutput(b.toString("utf8"), "stdout"));
    child.on("exit", (code) => {
      this.setStatus({ state: "terminated", error: code ? `exited with code ${code}` : undefined });
      this.cleanup();
    });

    let socket: Socket;
    try {
      socket = await connectWithRetry(port, 15_000);
    } catch (err) {
      child.kill();
      this.cleanup();
      const detail = stderr.includes("No module named debugpy")
        ? "debugpy is not installed in this interpreter (pip install debugpy)"
        : (err as Error).message;
      this.setStatus({ state: "terminated", error: detail });
      return { ok: false, error: detail };
    }

    this.socket = socket;
    const client = new DapClient((data) => socket.write(data));
    this.client = client;
    socket.on("data", (b: Buffer) => client.feed(b));
    socket.on("close", () => {
      client.close();
      this.setStatus({ state: "terminated" });
    });
    socket.on("error", () => { /* the close handler does the work */ });

    this.wireEvents(client);

    // `initialized` arrives as an EVENT, and may land before the `initialize`
    // response. Subscribing first is what makes the ordering reliable.
    const initialized = new Promise<void>((resolve) => {
      const off = client.on("initialized", () => { off(); resolve(); });
    });

    const init = await client.request("initialize", {
      clientID: "fove",
      adapterID: "debugpy",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    });
    if (!init.success) {
      await this.stop();
      return { ok: false, error: init.message ?? "initialize failed" };
    }

    /*
     * `attach` is deliberately NOT awaited here.
     *
     * Observed against debugpy 1.8.21, not assumed: it answers `attach` only
     * *after* `configurationDone`, so awaiting the response before sending the
     * rest of the configuration deadlocks -- the client waits for a reply that
     * cannot arrive until the client sends more. The first version of this did
     * exactly that and failed with "attach timed out".
     *
     * The fake adapter in the tests replied immediately, which is precisely
     * why this had to be checked against the real thing.
     */
    const attached = client.request("attach", {
      justMyCode: config.justMyCode ?? true,
      connect: { host: "127.0.0.1", port },
    });

    // Breakpoints are only accepted between `initialized` and
    // `configurationDone`; sending them earlier drops them silently.
    await initialized;
    for (const bp of opts.breakpoints ?? []) {
      const lines = this.breakpoints.get(bp.path) ?? [];
      if (!lines.includes(bp.line)) lines.push(bp.line);
      this.breakpoints.set(bp.path, lines);
    }
    for (const [path, lines] of this.breakpoints) await this.sendBreakpoints(path, lines);

    // Without this the program stays paused at startup, which looks like a hang.
    await client.request("configurationDone");

    // Now `attach` can complete: see the comment above.
    const launch = await attached;
    if (!launch.success) {
      await this.stop();
      return { ok: false, error: launch.message ?? "attach failed" };
    }

    this.setStatus({ state: "running" });
    return { ok: true };
  }

  private wireEvents(client: DapClient): void {
    client.on("stopped", (body) => {
      const b = body as { reason?: string; threadId?: number };
      this.setStatus({ state: "paused", reason: b?.reason, threadId: b?.threadId });
    });
    client.on("continued", () => this.setStatus({ state: "running" }));
    client.on("terminated", () => this.setStatus({ state: "terminated" }));
    client.on("exited", () => this.setStatus({ state: "terminated" }));
    client.on("output", (body) => {
      const b = body as { output?: string; category?: string };
      if (b?.output) this.onOutput(b.output, b.category ?? "console");
    });
  }

  /**
   * Replace the breakpoints for one file.
   *
   * DAP has no "add one breakpoint": `setBreakpoints` is the complete set for a
   * source, so the caller's per-file list is authoritative.
   */
  async setBreakpoints(path: string, lines: number[]): Promise<void> {
    this.breakpoints.set(path, [...lines].sort((a, b) => a - b));
    if (this.client) await this.sendBreakpoints(path, this.breakpoints.get(path)!);
  }

  private async sendBreakpoints(path: string, lines: number[]): Promise<void> {
    await this.client?.request("setBreakpoints", {
      source: { path },
      breakpoints: lines.map((line) => ({ line })),
    });
  }

  async stackTrace(threadId?: number): Promise<StackFrame[]> {
    const id = threadId ?? this.status.threadId;
    if (!this.client || id === undefined) return [];
    const r = await this.client.request("stackTrace", { threadId: id, levels: 50 });
    if (!r.success) return [];
    const frames = (r.body as { stackFrames?: unknown[] })?.stackFrames ?? [];
    return frames.map((raw) => {
      const f = raw as { id: number; name: string; line: number; column: number; source?: { path?: string } };
      return { id: f.id, name: f.name, line: f.line, column: f.column, path: f.source?.path };
    });
  }

  async scopes(frameId: number): Promise<Scope[]> {
    if (!this.client) return [];
    const r = await this.client.request("scopes", { frameId });
    if (!r.success) return [];
    return ((r.body as { scopes?: Scope[] })?.scopes ?? []).map((s) => ({
      name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive,
    }));
  }

  async variables(reference: number): Promise<Variable[]> {
    if (!this.client) return [];
    const r = await this.client.request("variables", { variablesReference: reference });
    if (!r.success) return [];
    return ((r.body as { variables?: Variable[] })?.variables ?? []).map((v) => ({
      name: v.name, value: v.value, type: v.type,
      variablesReference: v.variablesReference ?? 0,
    }));
  }

  /** Evaluate an expression in a paused frame, for the watch box. */
  async evaluate(expression: string, frameId?: number): Promise<{ value: string; error?: string }> {
    if (!this.client) return { value: "", error: "no debug session" };
    const r = await this.client.request("evaluate", {
      expression, frameId, context: "repl",
    });
    if (!r.success) return { value: "", error: r.message ?? "could not evaluate" };
    const body = r.body as { result?: string };
    return { value: body?.result ?? "" };
  }

  private async step(command: string): Promise<void> {
    const id = this.status.threadId;
    if (!this.client || id === undefined) return;
    // Report running immediately: the adapter will send `stopped` when it
    // lands, and leaving the UI on "paused" makes the click feel dead.
    this.setStatus({ state: "running" });
    await this.client.request(command, { threadId: id });
  }

  continue_(): Promise<void> { return this.step("continue"); }
  stepOver(): Promise<void> { return this.step("next"); }
  stepIn(): Promise<void> { return this.step("stepIn"); }
  stepOut(): Promise<void> { return this.step("stepOut"); }

  async pause(): Promise<void> {
    const id = this.status.threadId ?? 1;
    await this.client?.request("pause", { threadId: id });
  }

  /** End the session and the process under it. */
  async stop(): Promise<void> {
    // Ask politely first; a debugpy that has already died just fails this.
    if (this.client && !this.client.isClosed) {
      await this.client.request("disconnect", { terminateDebuggee: true }, 2000);
    }
    this.child?.kill();
    this.cleanup();
    this.setStatus({ state: "terminated" });
  }

  private cleanup(): void {
    this.client?.close();
    this.client = null;
    this.socket?.destroy();
    this.socket = null;
    this.child = null;
  }

  private setStatus(status: DebugStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
