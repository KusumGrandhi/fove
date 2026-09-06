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

import { CaptureBuffer, type Capture } from "./capture.ts";

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
  private server?: ReturnType<typeof Bun.serve>;
  private upstream: Upstream = ANTHROPIC;
  onCapture?: () => void;

  get port(): number | undefined {
    return this.server?.port;
  }

  get baseUrl(): string | undefined {
    return this.server ? `http://127.0.0.1:${this.server.port}` : undefined;
  }

  get current(): Upstream {
    return this.upstream;
  }

  /** Swap the upstream. Takes effect on the next request; no restart. */
  setUpstream(u: Upstream): void {
    this.upstream = u;
  }

  start(): string {
    if (this.server) return this.baseUrl!;
    this.server = Bun.serve({
      port: 0, // ephemeral
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    return this.baseUrl!;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  private async handle(req: Request): Promise<Response> {
    const inUrl = new URL(req.url);
    const target = new URL(inUrl.pathname + inUrl.search, this.upstream.baseUrl);

    const headers = new Headers(req.headers);
    headers.set("host", target.host);
    if (this.upstream.authToken) {
      // A third-party endpoint authenticates with its own key.
      headers.set("authorization", `Bearer ${this.upstream.authToken}`);
      headers.delete("x-api-key");
    }

    const body = req.body ? await req.text() : undefined;
    const cap = this.captures.begin(req.method, target.toString(), req.headers, body);
    this.onCapture?.();

    try {
      const res = await fetch(target, {
        method: req.method,
        headers,
        body,
        duplex: "half",
      });

      if (!res.body) {
        const text = await res.text();
        this.captures.finish(cap, res.status, res.headers, text);
        this.onCapture?.();
        return new Response(text, { status: res.status, headers: res.headers });
      }

      // Tee so the client streams while we assemble the capture.
      const [toClient, toCapture] = res.body.tee();
      void this.collect(cap, res, toCapture);
      return new Response(toClient, { status: res.status, headers: res.headers });
    } catch (e) {
      this.captures.fail(cap, String(e));
      this.onCapture?.();
      return new Response(JSON.stringify({ error: { message: String(e) } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  private async collect(cap: Capture, res: Response, stream: ReadableStream<Uint8Array>): Promise<void> {
    const chunks: string[] = [];
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(dec.decode(chunk, { stream: true }));
      }
    } catch (e) {
      this.captures.fail(cap, String(e));
    }
    this.captures.finish(cap, res.status, res.headers, chunks.join(""));
    this.onCapture?.();
  }
}
