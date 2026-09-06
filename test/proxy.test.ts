import { expect, test, describe, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { InspectorProxy } from "../src/proxy/server.js";
import { CaptureBuffer, safeHeaders, sniff, toCurl, truncateBody, REDACTED } from "../src/proxy/capture.js";

describe("capture helpers", () => {
  test("masks credential headers, keeps the rest", () => {
    const h = new Headers({ authorization: "Bearer secret", "x-api-key": "sk-ant-xyz", "content-type": "application/json" });
    const out = safeHeaders(h);
    expect(out.authorization).toBe(REDACTED);
    expect(out["x-api-key"]).toBe(REDACTED);
    expect(out["content-type"]).toBe("application/json");
  });
  test("sniffs model and usage out of a body", () => {
    const body = '{"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":900}}';
    const s = sniff(body);
    expect(s.model).toBe("claude-opus-5");
    expect(s.usage).toMatchObject({ input: 100, output: 5, cacheRead: 900 });
  });
  test("takes the LAST output_tokens, as SSE reports a growing count", () => {
    expect(sniff('"output_tokens":1 ... "output_tokens":42').usage?.output).toBe(42);
  });
  test("truncates oversized bodies and says so", () => {
    const out = truncateBody("x".repeat(300_000));
    expect(out.length).toBeLessThan(300_000);
    expect(out).toContain("truncated");
  });
  test("ring buffer evicts oldest first", () => {
    const b = new CaptureBuffer(3);
    for (let i = 0; i < 5; i++) b.begin("POST", `/v1/${i}`, new Headers());
    const ids = b.list().map((c) => c.url);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toContain("/v1/4");   // newest first
    expect(ids.some((u) => u.includes("/v1/0"))).toBe(false);
  });
  test("curl output never contains a live credential", () => {
    const b = new CaptureBuffer();
    const c = b.begin("POST", "https://api.anthropic.com/v1/messages",
      new Headers({ "x-api-key": "sk-ant-REALSECRET", "content-type": "application/json" }), '{"model":"x"}');
    const curl = toCurl(c);
    expect(curl).not.toContain("REALSECRET");
    expect(curl).toContain(REDACTED);
    expect(curl).toContain("curl -X POST");
  });
});


/** Spin up a throwaway upstream server for the proxy to forward to. */
async function upstreamServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0 };
}

describe("InspectorProxy", () => {
  let upstream: Server | undefined;
  let proxy: InspectorProxy | undefined;
  afterEach(() => { upstream?.close(); proxy?.stop(); upstream = undefined; proxy = undefined; });

  test("forwards a request and captures both sides", async () => {
    const up = await upstreamServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        echo: JSON.parse(Buffer.concat(chunks).toString()),
        usage: { input_tokens: 7, output_tokens: 3 },
      }));
    });
    upstream = up.server;
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${up.port}`, label: "test" });
    const base = await proxy.start();

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-SECRET" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).echo.model).toBe("claude-opus-5");

    await new Promise((r) => setTimeout(r, 60));
    const [cap] = proxy.captures.list();
    expect(cap!.model).toBe("claude-opus-5");
    expect(cap!.status).toBe(200);
    expect(cap!.requestHeaders["x-api-key"]).toBe(REDACTED);  // never stored raw
    expect(cap!.usage).toMatchObject({ input: 7, output: 3 });
  });

  test("streams a response through rather than buffering it", async () => {
    const up = await upstreamServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\n");
      await new Promise((r) => setTimeout(r, 40));
      res.write('data: {"output_tokens":9}\n');
      res.end();
    });
    upstream = up.server;
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${up.port}`, label: "test" });
    const base = await proxy.start();

    const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
    const reader = res.body!.getReader();
    const first = await reader.read();          // arrives before the stream ends
    expect(new TextDecoder().decode(first.value)).toContain("event: a");
    while (!(await reader.read()).done) { /* drain */ }

    await new Promise((r) => setTimeout(r, 80));
    const [cap] = proxy.captures.list();
    expect(cap!.responseBody).toContain("output_tokens");
    expect(cap!.usage?.output).toBe(9);
  });

  test("swapping upstream reroutes without a restart", async () => {
    const A = await upstreamServer((_q, res) => res.end("from-A"));
    const B = await upstreamServer((_q, res) => res.end("from-B"));
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${A.port}`, label: "A" });
    const base = await proxy.start();
    expect(await (await fetch(`${base}/x`)).text()).toBe("from-A");

    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${B.port}`, label: "B", thirdParty: true });
    expect(await (await fetch(`${base}/x`)).text()).toBe("from-B");
    expect(proxy.baseUrl).toBe(base);           // same URL: the client never notices
    A.server.close(); B.server.close();
  });

  test("an unreachable upstream returns 502 rather than throwing", async () => {
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: "http://127.0.0.1:1", label: "dead" });
    const base = await proxy.start();
    const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(proxy.captures.list()[0]!.error).toBeTruthy();
  });
});
