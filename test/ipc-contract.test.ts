import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { CH } from "../src/shared/ipc.js";

/**
 * The preload script cannot import shared modules (Electron loads it as one
 * file with no resolution), so it redeclares the channel names. This test is
 * what keeps the copy honest.
 */
describe("preload channel contract", () => {
  const preload = readFileSync("src/main/preload.ts", "utf8");
  test("every shared channel appears in the preload copy", () => {
    for (const [key, value] of Object.entries(CH)) {
      expect(preload, `missing ${key}`).toContain(`"${value}"`);
    }
  });
  test("the preload declares no bare imports beyond electron", () => {
    const imports = [...preload.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["electron"]);
  });
});
