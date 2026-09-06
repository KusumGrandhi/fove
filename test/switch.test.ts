import { expect, test, describe, afterEach } from "bun:test";
import { InspectorProxy, ANTHROPIC } from "../src/proxy/server.ts";

/**
 * The claim M5 rests on: swapping provider is a routing change inside the
 * proxy, so the client keeps its connection and the UI keeps its state.
 */
describe("seamless provider switch", () => {
  let a: ReturnType<typeof Bun.serve> | undefined;
  let b: ReturnType<typeof Bun.serve> | undefined;
  let proxy: InspectorProxy | undefined;
  afterEach(() => { a?.stop(true); b?.stop(true); proxy?.stop(); a = b = undefined; proxy = undefined; });

  test("the proxy URL is stable across a provider change", async () => {
    a = Bun.serve({ port: 0, fetch: () => new Response('{"provider":"anthropic"}') });
    b = Bun.serve({ port: 0, fetch: (req) =>
      new Response(JSON.stringify({ provider: "kimi", auth: req.headers.get("authorization") })) });

    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${a.port}`, label: "Anthropic" });
    const url = proxy.start();

    const r1 = await (await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })).json() as any;
    expect(r1.provider).toBe("anthropic");

    // Switch: same proxy, same URL, no restart.
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${b.port}`, authToken: "kimi-key", thirdParty: true, label: "Kimi" });
    expect(proxy.baseUrl).toBe(url);

    const r2 = await (await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })).json() as any;
    expect(r2.provider).toBe("kimi");
    expect(r2.auth).toBe("Bearer kimi-key");   // provider's own credential applied
    expect(proxy.current.thirdParty).toBe(true);
  });

  test("captures from both providers land in one history", async () => {
    a = Bun.serve({ port: 0, fetch: () => new Response('{"model":"claude-opus-5"}') });
    b = Bun.serve({ port: 0, fetch: () => new Response('{"model":"kimi-k2.5"}') });
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${a.port}`, label: "A" });
    const url = proxy.start();
    await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${b.port}`, thirdParty: true, label: "B" });
    await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    await Bun.sleep(80);
    const models = proxy.captures.list().map((c) => c.model);
    expect(models).toContain("kimi-k2.5");
    expect(models).toContain("claude-opus-5");
  });

  test("switching back to Anthropic drops the third-party credential", async () => {
    a = Bun.serve({ port: 0, fetch: (req) => new Response(JSON.stringify({ auth: req.headers.get("authorization") })) });
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${a.port}`, authToken: "third-party", thirdParty: true, label: "X" });
    const url = proxy.start();
    expect(((await (await fetch(`${url}/x`, { method: "POST", body: "{}" })).json()) as any).auth).toBe("Bearer third-party");

    proxy.setUpstream({ ...ANTHROPIC, baseUrl: `http://127.0.0.1:${a.port}` });
    const back = (await (await fetch(`${url}/x`, { method: "POST", body: "{}" })).json()) as any;
    expect(back.auth).not.toBe("Bearer third-party");
    expect(proxy.current.thirdParty).toBeFalsy();
  });
});
