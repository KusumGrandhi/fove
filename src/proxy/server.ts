/**
 * Local reverse proxy in front of the Anthropic API.
 *
 * Two features ride on one piece of machinery:
 *
 *   1. RAW API INSPECTOR. No SDK method exposes the wire request, so the only
 *      faithful way to show it is to sit in the path and tee it.
 *   2. PROVIDER SWITCHING. Because the proxy holds the upstream, swapping
 *      provider is a routing-table change here rather than a client teardown --
 *      so the conversation view never resets when the backend changes.
 *
 * Off by default and opt-in per session: a proxy in the request path is
 * something the user should never forget is there.
 *
 * Streaming is preserved by tee-ing the response body: the client gets bytes as
 * they arrive, and the capture is assembled in parallel. Buffering the whole
 * response first would destroy the streaming the TUI depends on.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CaptureBuffer, type Capture } from "./capture.js";

export interface Upstream {
  /** Base URL, e.g. https://api.anthropic.com or a third-party endpoint. */
  baseUrl: string;
  /** Replacement auth header value, when the provider needs its own key. */
  authToken?: string;
  /** True for anything that is not Anthropic's own API. */
  thirdParty?: boolean;
  label: string;
}

export const ANTHROPIC: Upstream = {
  baseUrl: "https://api.anthropic.com",
  label: "Anthropic",
};

export class InspectorProxy {
  readonly captures = new CaptureBuffer();
  private server?: Server;
  private upstream: Upstream = ANTHROPIC;
  private boundPort?: number;
  onCapture?: () => void;

  get port(): number | undefined {
    return this.boundPort;
  }

  get baseUrl(): string | undefined {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}` : undefined;
  }

  get current(): Upstream {
    return this.upstream;
  }

  /** Swap the upstream. Takes effect on the next request; no restart. */
  setUpstream(u: Upstream): void {
    this.upstream = u;
  }

  /** Start listening on an ephemeral loopback port. */
  async start(): Promise<string> {
    if (this.server && this.boundPort) return this.baseUrl!;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : undefined;
        resolve();
      });
    });
    return this.baseUrl!;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.boundPort = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = new URL(req.url ?? "/", this.upstream.baseUrl);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      // Hop-by-hop headers must not be forwarded.
      if (k === "host" || k === "connection" || k === "content-length") continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    if (this.upstream.authToken) {
      // A third-party endpoint authenticates with its own key.
      headers.set("authorization", `Bearer ${this.upstream.authToken}`);
      headers.delete("x-api-key");
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;

    const reqHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) reqHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const cap = this.captures.begin(req.method ?? "GET", target.toString(), reqHeaders, body);
    this.onCapture?.();

    try {
      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });

      const outHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((v, k) => {
        if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") {
          outHeaders[k] = v;
        }
      });
      res.writeHead(upstreamRes.status, outHeaders);

      if (!upstreamRes.body) {
        const text = await upstreamRes.text();
        this.captures.finish(cap, upstreamRes.status, upstreamRes.headers, text);
        this.onCapture?.();
        res.end(text);
        return;
      }

      // Stream to the client while assembling the capture, so nothing is
      // buffered whole -- the TUI depends on tokens arriving as they are sent.
      const collected: string[] = [];
      const dec = new TextDecoder();
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        collected.push(dec.decode(chunk, { stream: true }));
        res.write(Buffer.from(chunk));
      }
      res.end();
      this.captures.finish(cap, upstreamRes.status, upstreamRes.headers, collected.join(""));
      this.onCapture?.();
    } catch (e) {
      this.captures.fail(cap, String(e));
      this.onCapture?.();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  }
}


