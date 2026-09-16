import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseInterpreter, chosenInterpreter, setStorePath } from "../src/main/pythonEnv.js";
import { interpreterFor } from "../src/main/interpreters.js";

/**
 * Nothing on disk says which Python a project uses.
 *
 * `core` uses conda and says so nowhere -- no pyrightconfig, no pyproject, and
 * a README describing a venv its author abandoned. Two conda environments that
 * differ only by Python version resolve every third-party import to a
 * different site-packages, so a wrong guess sends go-to-definition into the
 * wrong copy of Flask without ever saying so. Hence: the user chooses, and the
 * choice sticks.
 */
describe("the interpreter a project uses is remembered, not guessed", () => {
  let dir: string;
  let store: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fove-py-"));
    store = join(dir, "python.json");
    setStorePath(store);
  });

  afterEach(() => {
    setStorePath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a choice survives being written and read back", () => {
    expect(chosenInterpreter("/some/project")).toBeNull();
    chooseInterpreter("/some/project", "/envs/aipenv-new/bin/python");
    expect(chosenInterpreter("/some/project")).toBe("/envs/aipenv-new/bin/python");

    // A fresh read of the same file, as the next launch would do.
    setStorePath(store);
    expect(chosenInterpreter("/some/project")).toBe("/envs/aipenv-new/bin/python");
  });

  test("projects do not share a choice", () => {
    chooseInterpreter("/a", "/envs/one/bin/python");
    chooseInterpreter("/b", "/envs/two/bin/python");
    expect(chosenInterpreter("/a")).toBe("/envs/one/bin/python");
    expect(chosenInterpreter("/b")).toBe("/envs/two/bin/python");
  });

  test("null forgets it, falling back to detection", () => {
    chooseInterpreter("/a", "/envs/one/bin/python");
    chooseInterpreter("/a", null);
    expect(chosenInterpreter("/a")).toBeNull();
  });

  test("the choice beats a project-local venv that detection would prefer", async () => {
    // A .venv in the project is the strongest signal detection has -- and it
    // still must not override an explicit answer, because a repository can
    // carry a venv its author stopped using. `core` carries exactly that.
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(dir, ".venv", "bin", "python"), "");
    expect(await interpreterFor(dir)).toBe(join(dir, ".venv", "bin", "python"));

    chooseInterpreter(dir, "/envs/aipenv-new/bin/python");
    expect(await interpreterFor(dir)).toBe("/envs/aipenv-new/bin/python");
  });
});
