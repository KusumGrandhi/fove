import { describe, expect, test } from "vitest";
import { languageFor } from "../src/main/files.js";

/**
 * The renderer resolves languages from Monaco's own registry (~91 languages,
 * verified in the app). This covers the main-process hint map used when no
 * editor is involved, and the extensionless names a registry lookup misses.
 */
describe("languageFor (main-process hint)", () => {
  test("common source extensions", () => {
    expect(languageFor("a/x.ts")).toBe("typescript");
    expect(languageFor("a/x.py")).toBe("python");
    expect(languageFor("a/x.go")).toBe("go");
    expect(languageFor("a/x.rs")).toBe("rust");
    expect(languageFor("a/x.java")).toBe("java");
  });
  test("extensionless files recognised by name", () => {
    expect(languageFor("a/Dockerfile")).toBe("dockerfile");
    expect(languageFor("a/Makefile")).toBe("makefile");
  });
  test("dotfile families", () => {
    expect(languageFor("a/.env")).toBe("ini");
    expect(languageFor("a/.env.local")).toBe("ini");
  });
  test("case-insensitive extensions", () => {
    expect(languageFor("a/X.TS")).toBe("typescript");
    expect(languageFor("a/README.MD")).toBe("markdown");
  });
  test("unknown extensions fall back rather than throwing", () => {
    expect(languageFor("a/x.qqq")).toBe("plaintext");
    expect(languageFor("a/noext")).toBe("plaintext");
    expect(languageFor("")).toBe("plaintext");
  });
});
