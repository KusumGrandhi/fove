/**
 * What a file card says, in words a reader will recognise.
 *
 * The first version of this card was written in the vocabulary of the code
 * that produces it -- "CONTRACT — EXTRACTED, NOT WRITTEN", "INVARIANTS",
 * "inferred from the source", "nothing exported". Every one of those explains
 * *how the value was produced* rather than what the reader is being told, and
 * a card nobody can read is the same as an empty one.
 *
 * The rule these pin down: say what it means for the reader, and never dress
 * up an absence as information.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeelService } from "../src/main/keel.js";

let dir: string;
const service = () => new KeelService({} as never);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fove-card-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string): string => {
  writeFileSync(join(dir, name), body);
  return name;
};

describe("the description line", () => {
  it("uses the author's own words when they wrote some", async () => {
    const f = write("a.py", 'def charge(x):\n    """Take payment and return the receipt."""\n    return 1\n');
    const c = await service().card(dir, f);
    expect(c.purpose).toBe("Take payment and return the receipt.");
  });

  it("does not call an author's description a guess", async () => {
    /*
     * `purposeInferred` was hardcoded true, so a real docstring was tagged
     * "we guessed this" -- which teaches the reader to distrust the one line
     * on the card that was actually written by a person.
     */
    const f = write("a.py", 'def charge(x):\n    """Take payment."""\n    return 1\n');
    expect((await service().card(dir, f)).purposeInferred).toBe(false);
  });

  it("says plainly that nobody wrote one, rather than counting exports", async () => {
    /*
     * "Exports 6 names." reads as a description while telling you nothing
     * about what the file is for. The count is already the contract column.
     */
    const f = write("b.py", "def charge(x):\n    return 1\n");
    const c = await service().card(dir, f);

    expect(c.purpose).toContain("Nobody has written down");
    expect(c.purpose).not.toMatch(/Exports \d+ name/);
    expect(c.purposeInferred).toBe(true);
  });

  it("says so when nothing uses the file at all", async () => {
    const f = write("c.py", "_x = 1\n");
    const c = await service().card(dir, f);
    expect(c.purpose).toContain("Nothing else uses this file");
  });
});
