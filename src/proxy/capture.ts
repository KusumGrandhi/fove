/**
 * Bounded ring buffer of request/response pairs seen by the local proxy.
 *
 * Bodies are capped: a single Claude request can carry a megabyte of system
 * prompt and conversation, and keeping every one would dwarf the app.
 */

export interface Capture {
  id: number;
  method: string;
  url: string;
  model?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  startedAt: number;
  endedAt?: number;
  /** Token counts parsed out of the response, when present. */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  error?: string;
}

const MAX_BODY = 256 * 1024;
const AUTH = /^(authorization|x-api-key|anthropic-auth|proxy-authorization)$/i;
export const REDACTED = "••••";

/** Copy headers, masking anything that carries a credential. */
export function safeHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = AUTH.test(k) ? REDACTED : v;
  });
  return out;
}

export function truncateBody(s: string): string {
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n…[truncated ${s.length - MAX_BODY} bytes]` : s;
}

/** Pull model and usage out of a request/response body, best effort. */
export function sniff(body: string): { model?: string; usage?: Capture["usage"] } {
  const out: { model?: string; usage?: Capture["usage"] } = {};
  const model = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (model) out.model = model;
  // Usage appears in message_start / message_delta SSE frames and JSON bodies.
  const input = /"input_tokens"\s*:\s*(\d+)/.exec(body)?.[1];
  const output = /"output_tokens"\s*:\s*(\d+)/g;
  let last: RegExpExecArray | null, outTok: string | undefined;
  while ((last = output.exec(body)) !== null) outTok = last[1]; // take the final one
  const cacheRead = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(body)?.[1];
  const cacheWrite = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(body)?.[1];
  if (input || outTok || cacheRead || cacheWrite) {
    out.usage = {
      input: input ? Number(input) : undefined,
      output: outTok ? Number(outTok) : undefined,
      cacheRead: cacheRead ? Number(cacheRead) : undefined,
      cacheWrite: cacheWrite ? Number(cacheWrite) : undefined,
    };
  }
  return out;
}

export class CaptureBuffer {
  private readonly items: Capture[] = [];
  private nextId = 1;
  constructor(private readonly max = 200) {}

  begin(method: string, url: string, headers: Headers, body?: string): Capture {
    const c: Capture = {
      id: this.nextId++,
      method,
      url,
      requestHeaders: safeHeaders(headers),
      requestBody: body ? truncateBody(body) : undefined,
      startedAt: Date.now(),
    };
    if (body) c.model = sniff(body).model;
    this.items.push(c);
    if (this.items.length > this.max) this.items.shift();
    return c;
  }

  finish(c: Capture, status: number, headers: Headers, body: string): void {
    c.status = status;
    c.responseHeaders = safeHeaders(headers);
    c.responseBody = truncateBody(body);
    c.endedAt = Date.now();
    const s = sniff(body);
    c.usage = s.usage;
    c.model ??= s.model;
  }

  fail(c: Capture, error: string): void {
    c.error = error;
    c.endedAt = Date.now();
  }

  list(): Capture[] {
    return [...this.items].reverse(); // newest first
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Reconstruct an equivalent curl command for a capture. */
export function toCurl(c: Capture): string {
  const parts = [`curl -X ${c.method} '${c.url}'`];
  for (const [k, v] of Object.entries(c.requestHeaders)) {
    if (k.toLowerCase() === "content-length") continue;
    parts.push(`  -H '${k}: ${v}'`);
  }
  if (c.requestBody) {
    const body = c.requestBody.length > 2000 ? `${c.requestBody.slice(0, 2000)}…` : c.requestBody;
    parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(" \\\n");
}
