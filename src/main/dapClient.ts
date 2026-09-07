/**
 * A DAP client: request/response correlation over a byte stream.
 *
 * Deliberately transport-agnostic. It is handed a duplex (write bytes out, feed
 * bytes in) rather than opening a socket itself, so the whole protocol layer is
 * testable against a fake adapter with no process and no port -- which is how
 * the layout engine and the commit graph were built, and why both worked first
 * time.
 *
 * What this owns:
 *   - `seq` allocation and matching responses to requests.
 *   - Timeouts, so a wedged adapter fails a request instead of hanging the UI
 *     on a promise that never settles.
 *   - Rejecting every in-flight request when the connection drops, for the same
 *     reason. A debug session dies with the process it is debugging, and that
 *     is normal, not exceptional.
 *
 * What it does not own: launching debugpy, mapping breakpoints to the editor,
 * or any UI. Those sit above it.
 */

import { DapDecoder, encode, type DapMessage } from "../shared/dap.js";

export interface DapResponse {
  success: boolean;
  body?: unknown;
  message?: string;
}

/** How long a request waits before failing. Adapters are usually instant. */
const DEFAULT_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (r: DapResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DapClient {
  private readonly decoder = new DapDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, ((body: unknown) => void)[]>();
  private seq = 1;
  private closed = false;

  /**
   * `write` puts bytes on the wire. Everything read off the wire comes back
   * through `feed`.
   */
  constructor(private readonly write: (data: Buffer) => void) {}

  /** Push bytes received from the adapter. */
  feed(chunk: Buffer): void {
    for (const msg of this.decoder.push(chunk)) this.handle(msg);
  }

  /** Subscribe to a DAP event ("stopped", "output", "terminated", ...). */
  on(event: string, fn: (body: unknown) => void): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return () => {
      const now = this.listeners.get(event);
      if (!now) return;
      const at = now.indexOf(fn);
      if (at >= 0) now.splice(at, 1);
    };
  }

  /**
   * Send a request and wait for its response.
   *
   * Never rejects: a failed request resolves with `success: false`. A debugger
   * command failing ("cannot evaluate in this frame") is an ordinary outcome to
   * show in the UI, not an exception to unwind through.
   */
  request(
    command: string,
    args?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<DapResponse> {
    if (this.closed) {
      return Promise.resolve({ success: false, message: "debug session is not running" });
    }
    const seq = this.seq++;
    return new Promise<DapResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ success: false, message: `${command} timed out` });
      }, timeoutMs);
      this.pending.set(seq, { resolve, timer });

      try {
        this.write(encode({ seq, type: "request", command, arguments: args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(seq);
        resolve({ success: false, message: (err as Error).message });
      }
    });
  }

  /**
   * The connection is gone.
   *
   * Every waiting request is settled rather than left pending: a UI awaiting a
   * stack trace from a process that has exited would otherwise sit there
   * forever.
   */
  close(reason = "debug session ended"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ success: false, message: reason });
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private handle(msg: DapMessage): void {
    if (msg.type === "response") {
      const seq = msg.request_seq;
      if (typeof seq !== "number") return;
      const p = this.pending.get(seq);
      // A response to a request that already timed out: drop it rather than
      // resolving a promise nobody holds.
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(seq);
      p.resolve({ success: msg.success !== false, body: msg.body, message: msg.message });
      return;
    }

    if (msg.type === "event" && msg.event) {
      for (const fn of this.listeners.get(msg.event) ?? []) {
        // One bad listener must not stop the others, or a render error would
        // silently stop the debugger from updating.
        try { fn(msg.body); } catch { /* keep going */ }
      }
      return;
    }

    // A `request` from the adapter (runInTerminal) is not supported; ignoring
    // it is better than replying with something wrong.
  }
}
