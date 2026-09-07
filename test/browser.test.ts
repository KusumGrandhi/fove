/**
 * The browser pane's URL gate.
 *
 * `toUrl` is the boundary between what the user types and what a Chromium view
 * loads, so it is tested on its own rather than only through the pane. The
 * rejection cases matter more than the acceptance ones.
 */

import { describe, expect, it } from "vitest";
import { isElectronNoise, toUrl } from "../src/main/browser.js";

describe("toUrl", () => {
  it("assumes http for a bare host, the common local case", () => {
    expect(toUrl("localhost:5000")).toBe("http://localhost:5000/");
  });

  it("reads host:port as a host, not as a scheme", () => {
    // `localhost:5000` is the Flask dev server and the single most likely
    // thing typed here; a naive scheme regex reads "localhost" as the scheme
    // and rejects it.
    expect(toUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(toUrl("example.com:3000")).toBe("http://example.com:3000/");
  });

  it("keeps an explicit scheme", () => {
    expect(toUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("accepts about:blank", () => {
    expect(toUrl("about:blank")).toBe("about:blank");
  });

  it("trims surrounding whitespace", () => {
    expect(toUrl("  http://a.test/  ")).toBe("http://a.test/");
  });

  it("rejects an empty query", () => {
    expect(toUrl("")).toBeNull();
    expect(toUrl("   ")).toBeNull();
  });

  it("rejects file:, so the pane cannot be aimed at the filesystem", () => {
    expect(toUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects javascript:, which would run in the page", () => {
    expect(toUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects a data: URL", () => {
    expect(toUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects other schemes outright rather than guessing", () => {
    expect(toUrl("ftp://example.com")).toBeNull();
    expect(toUrl("chrome://settings")).toBeNull();
  });

  it("treats a path-only entry as a host, not a scheme", () => {
    // "example.com/a:b" must not be read as the scheme "example.com".
    expect(toUrl("example.com/a")).toBe("http://example.com/a");
  });
});

describe("isElectronNoise", () => {
  it("drops Electron's own security warning", () => {
    // It is about the app's configuration, not the page's code. Letting it
    // through hands Claude a problem the user cannot fix where they are looking.
    expect(isElectronNoise("%cElectron Security Warning (Insecure CSP)", "")).toBe(true);
  });

  it("drops anything from Electron's injected bundle", () => {
    expect(isElectronNoise("whatever", "sandbox_bundle:2")).toBe(true);
  });

  it("keeps a real page error", () => {
    expect(isElectronNoise("TypeError: x is not a function", "http://localhost:5000/app.js"))
      .toBe(false);
  });

  it("keeps a page error that merely mentions Electron", () => {
    expect(isElectronNoise("failed to load electron-shim", "http://localhost:5000/a.js"))
      .toBe(false);
  });
});
