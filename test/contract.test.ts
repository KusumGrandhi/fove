/**
 * Extracting a file's exported surface.
 *
 * This exists because an earlier version of the v0.9 plan declared it
 * impossible: `core` annotates 39% of return types, and I concluded there was
 * no type surface to extract. That was wrong. The surface is names, parameters
 * and whatever annotations are present, and `ast` produces it for any file that
 * parses at all -- so the interesting tests here are the degradations, not the
 * happy path.
 *
 * Python cases run against a real interpreter. Skipped, loudly, when none is
 * available rather than silently passing.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileContract } from "../src/main/contract.js";

const run = promisify(execFile);

let python: string | undefined;
let dir: string;

beforeAll(async () => {
  for (const candidate of ["python3", "python"]) {
    try {
      await run(candidate, ["-c", "import ast, json"]);
      python = candidate;
      break;
    } catch {
      // try the next one
    }
  }
  dir = await mkdtemp(join(tmpdir(), "fove-contract-"));
  return async () => { await rm(dir, { recursive: true, force: true }); };
});

const write = async (name: string, body: string): Promise<string> => {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
};

describe("python", () => {
  it("extracts functions with their annotations", async () => {
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("a.py", [
      "def band_for(score: int, jurisdiction: str) -> str:",
      '    """Map a score to a band."""',
      "    return 'LOW'",
      "",
      "def helper():",
      "    pass",
    ].join("\n"));

    const c = await fileContract(p, python);
    expect(c.language).toBe("python");
    const band = c.entries.find((e) => e.name === "band_for")!;
    expect(band.signature).toBe("band_for(score: int, jurisdiction: str) -> str");
    expect(band.summary).toBe("Map a score to a band.");
    expect(band.line).toBe(1);
  });

  it("extracts an unannotated function, because the surface does not need types", async () => {
    // The case the plan wrongly called blocking. A name and its parameters are
    // still a contract; the annotations are a bonus.
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("b.py", "def screen(business, jurisdiction):\n    pass\n");
    const c = await fileContract(p, python);
    expect(c.entries[0]!.signature).toBe("screen(business, jurisdiction)");
  });

  it("keeps private names off the card", async () => {
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("c.py", "def _internal():\n    pass\n\ndef public():\n    pass\n");
    const c = await fileContract(p, python);
    expect(c.entries.map((e) => e.name)).toEqual(["public"]);
  });

  it("extracts classes with their bases", async () => {
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("d.py", "class Record(Base, Mixin):\n    pass\n");
    const c = await fileContract(p, python);
    expect(c.entries[0]).toMatchObject({ kind: "class", signature: "Record(Base, Mixin)" });
  });

  it("takes UPPER_CASE module constants and leaves other assignments", async () => {
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("e.py", "TIMEOUT = 30\nlogger = get_logger()\n_PRIVATE = 1\n");
    const c = await fileContract(p, python);
    expect(c.entries.map((e) => e.name)).toEqual(["TIMEOUT"]);
  });

  it("handles *args and **kwargs", async () => {
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("f.py", "def call(url, *args, **kwargs):\n    pass\n");
    const c = await fileContract(p, python);
    expect(c.entries[0]!.signature).toBe("call(url, *args, **kwargs)");
  });

  it("reports a syntax error rather than an empty surface", async () => {
    // An unparseable file and a file with no exports look identical on a card
    // and mean opposite things. The note is what separates them.
    if (!python) return expect.unreachable("no python3 on PATH");
    const p = await write("bad.py", "def broken(:\n");
    const c = await fileContract(p, python);
    expect(c.entries).toEqual([]);
    expect(c.note).toMatch(/syntax error/);
  });

  it("says so when no interpreter was given", async () => {
    const p = await write("g.py", "def x(): pass\n");
    const c = await fileContract(p, undefined);
    expect(c.note).toMatch(/no Python interpreter/);
  });
});

describe("typescript", () => {
  it("extracts exported functions, classes, types and constants", async () => {
    const p = await write("a.ts", [
      "export function bandFor(score: number): Band {",
      "  return 'LOW';",
      "}",
      "export interface Band { name: string }",
      "export const MAX_SCORE = 1000;",
      "function notExported() {}",
      "const lower = 1;",
    ].join("\n"));

    const c = await fileContract(p);
    expect(c.language).toBe("typescript");
    const names = c.entries.map((e) => e.name);
    expect(names).toContain("bandFor");
    expect(names).toContain("Band");
    expect(names).toContain("MAX_SCORE");
    // Not exported, so not part of the surface.
    expect(names).not.toContain("notExported");
    expect(names).not.toContain("lower");
  });

  it("records the line, so a card can jump to it", async () => {
    const p = await write("b.ts", "\n\nexport function third() {}\n");
    const c = await fileContract(p);
    expect(c.entries[0]!.line).toBe(3);
  });

  it("handles an async export", async () => {
    const p = await write("c.ts", "export async function load(id: string): Promise<void> {}\n");
    const c = await fileContract(p);
    expect(c.entries[0]!.name).toBe("load");
  });
});

describe("degradation", () => {
  it("names the reason for a file type it cannot read", async () => {
    const p = await write("notes.md", "# hello\n");
    const c = await fileContract(p);
    expect(c.language).toBe("unknown");
    expect(c.note).toMatch(/no extractor/);
  });

  it("does not throw on a missing file", async () => {
    const c = await fileContract(join(dir, "nope.py"), python);
    expect(c.entries).toEqual([]);
    expect(c.note).toMatch(/could not read/);
  });

  it("returns an empty surface, not an error, for a file with no exports", async () => {
    const p = await write("empty.ts", "const x = 1;\n");
    const c = await fileContract(p);
    expect(c.entries).toEqual([]);
    expect(c.note).toBeUndefined();
  });
});

describe("export shapes real codebases actually use", () => {
  /*
   * The first version of this extractor was written against fove's own source
   * and silently reported "nothing exported" for anything else. Measured on
   * `core`'s frontend: 770 of 1777 files use `export default`, and every one
   * of them rendered as having no public surface.
   *
   * That is not a small failure. A contract card saying "nothing exported" is
   * a claim, and a false claim is worse than an incomplete one -- the whole
   * point of the card is that you can trust it while approving a handoff.
   */
  /** A fresh filename per case, so nothing is read from a stale fixture. */
  let n = 0;
  const surface = async (source: string): Promise<string[]> => {
    const f = join(dir, `s${n++}.tsx`);
    await writeFile(f, source);
    return (await fileContract(f)).entries.map((e) => e.name);
  };

  it("finds a bare default export", async () => {
    // The exact shape of the file that exposed this.
    expect(await surface("const Foo = () => null;\nexport default Foo;\n"))
      .toContain("Foo");
  });

  it("finds a default-exported function with destructured props", async () => {
    // The parameter list does not close on the same line, which is how most
    // React components are written.
    expect(await surface("export default function MenuPopover({\n  a,\n}) {}\n"))
      .toContain("MenuPopover");
  });

  it("finds a lower-case exported const", async () => {
    // The original pattern required SCREAMING_CASE, which excluded every
    // component, hook and arrow function.
    expect(await surface("export const useThing = () => 1;\n"))
      .toContain("useThing");
  });

  it("names the inner function of a forwardRef wrapper", async () => {
    expect(await surface(
      "export default forwardRef<HTMLDivElement, P>(function Card(props, ref) {})\n",
    )).toContain("Card");
  });

  it("names the component inside memo()", async () => {
    expect(await surface("const Icon = () => null;\nexport default memo(Icon);\n"))
      .toContain("Icon");
  });

  it("names a member-expression default by its tail", async () => {
    expect(await surface("export default slice.reducer;\n")).toContain("reducer");
  });

  it("lists every name in a re-export", async () => {
    const names = await surface('export { setLoading, setEnvironment as setEnv };\n');
    expect(names).toContain("setLoading");
    // `a as b` exports under the second name.
    expect(names).toContain("setEnv");
  });

  it("lists names destructured out of an exported const", async () => {
    expect(await surface("export const { setA, setB } = slice.actions;\n"))
      .toEqual(expect.arrayContaining(["setA", "setB"]));
  });

  it("finds an exported enum", async () => {
    expect(await surface("export enum Status { OK = 'ok' }\n")).toContain("Status");
  });

  it("still reports a default export it cannot name", async () => {
    /*
     * `export default forwardRef<P>(` with the function on the next line is
     * beyond a line-at-a-time reader. Saying "default export" is worth far
     * more than claiming the file exports nothing.
     */
    const names = await surface(
      "export default forwardRef<HTMLDivElement, P>(\n  (props, ref) => null,\n);\n",
    );
    expect(names).toEqual(["default"]);
  });

  it("reports nothing for a file that genuinely exports nothing", async () => {
    // The claim must still be available when it is true.
    expect(await surface("const private1 = 1;\nconsole.log(private1);\n")).toEqual([]);
  });
});
