import { expect, test, describe, afterEach } from "bun:test";
import { InspectorProxy } from "../src/proxy/server.ts";
import { CaptureBuffer, safeHeaders, sniff, toCurl, truncateBody, REDACTED } from "../src/proxy/capture.ts";

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

describe("InspectorProxy", () => {
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let proxy: InspectorProxy | undefined;
  afterEach(() => { upstream?.stop(true); proxy?.stop(); upstream = undefined; proxy = undefined; });

  test("forwards a request and captures both sides", async () => {
    upstream = Bun.serve({ port: 0, fetch: async (req) => {
      const body = await req.text();
      return new Response(JSON.stringify({ echo: JSON.parse(body), usage: { input_tokens: 7, output_tokens: 3 } }),
        { headers: { "content-type": "application/json" } });
    }});
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${upstream.port}`, label: "test" });
    const base = proxy.start();

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-SECRET" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).echo.model).toBe("claude-opus-5");

    await Bun.sleep(60);
    const [cap] = proxy.captures.list();
    expect(cap!.model).toBe("claude-opus-5");
    expect(cap!.status).toBe(200);
    expect(cap!.requestHeaders["x-api-key"]).toBe(REDACTED);  // never stored raw
    expect(cap!.usage).toMatchObject({ input: 7, output: 3 });
  });

  test("streams a response through rather than buffering it", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response(
      new ReadableStream({
        async start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode("event: a\n"));
          await Bun.sleep(40);
          c.enqueue(enc.encode('data: {"output_tokens":9}\n'));
          c.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })});
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${upstream.port}`, label: "test" });
    const base = proxy.start();

    const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
    const reader = res.body!.getReader();
    const first = await reader.read();          // arrives before the stream ends
    expect(new TextDecoder().decode(first.value)).toContain("event: a");
    while (!(await reader.read()).done) { /* drain */ }

    await Bun.sleep(80);
    const [cap] = proxy.captures.list();
    expect(cap!.responseBody).toContain("output_tokens");
    expect(cap!.usage?.output).toBe(9);
  });

  test("swapping upstream reroutes without a restart", async () => {
    const a = Bun.serve({ port: 0, fetch: () => new Response("from-A") });
    const b = Bun.serve({ port: 0, fetch: () => new Response("from-B") });
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${a.port}`, label: "A" });
    const base = proxy.start();
    expect(await (await fetch(`${base}/x`)).text()).toBe("from-A");

    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${b.port}`, label: "B", thirdParty: true });
    expect(await (await fetch(`${base}/x`)).text()).toBe("from-B");
    expect(proxy.baseUrl).toBe(base);           // same URL: the client never notices
    a.stop(true); b.stop(true);
  });

  test("an unreachable upstream returns 502 rather than throwing", async () => {
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: "http://127.0.0.1:1", label: "dead" });
    const base = proxy.start();
    const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(proxy.captures.list()[0]!.error).toBeTruthy();
  });
});
