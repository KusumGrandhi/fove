/**
 * Finding the Python that should run the debugger.
 *
 * This machine uses conda, not venvs, so "the python on PATH" is the wrong
 * answer: `/opt/miniconda3/bin/python3` is the base environment and does not
 * have this project's dependencies. `core`'s Flask lives in the `aipenv`
 * environment, and debugging with the base interpreter would fail at the first
 * import with a message that blames the code rather than the interpreter.
 *
 * So the candidates are gathered and offered, with a note about whether
 * `debugpy` is importable in each -- because that is the actual precondition,
 * and finding out by launching and reading a traceback is a poor way to learn
 * it.
 *
 * Best-effort throughout: an unreadable directory contributes nothing rather
 * than failing the list.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chosenInterpreter } from "./pythonEnv.js";

const run = promisify(execFile);

export interface Interpreter {
  path: string;
  /** "conda: aipenv", "venv: .venv", "system". */
  label: string;
  version?: string;
  /** Whether `import debugpy` succeeds. The precondition for debugging. */
  hasDebugpy?: boolean;
}

/** Project-local environment directories, in the order they are preferred. */
const LOCAL_ENVS = [".venv", "venv", ".flask_env", "env"];

/**
 * Every interpreter worth offering, project-local ones first.
 *
 * Order is the recommendation: a project-local environment is nearly always
 * the right answer, and the base conda install nearly always the wrong one.
 */
export async function findInterpreters(cwd: string): Promise<Interpreter[]> {
  const found: Interpreter[] = [];
  const seen = new Set<string>();

  const add = (path: string, label: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    found.push({ path, label });
  };

  // First, so the picker opens on it and `?? found[0]` fallbacks land on it.
  const chosen = chosenInterpreter(cwd);
  if (chosen && (await exists(chosen))) add(chosen, "chosen for this project");

  for (const dir of LOCAL_ENVS) {
    const path = join(cwd, dir, "bin", "python");
    if (await exists(path)) add(path, `${dir}`);
  }

  for (const env of await condaEnvs()) add(env.path, `conda: ${env.name}`);

  // Last: it is on PATH, so it is a legitimate answer, but on this machine it
  // is the conda base install and almost never the one wanted.
  for (const name of ["python3", "python"]) {
    const path = await which(name);
    if (path) add(path, "on PATH");
  }

  // Probing runs the interpreter twice; do them together rather than serially.
  return Promise.all(found.map(async (i) => ({ ...i, ...(await probe(i.path)) })));
}

/**
 * The one interpreter to tell a language server about.
 *
 * A language server that does not know the project's interpreter cannot see
 * its site-packages, so every third-party import is unresolved: `from flask
 * import make_response` answers nothing while a local variable on the next
 * line answers fine. That reads as "go-to-definition works on variables but
 * not on functions", which is a baffling way to discover you have a
 * configuration problem.
 *
 * Same order of preference as `findInterpreters`, but without probing each
 * candidate -- debugpy and version are the debugger's questions, not this one,
 * and starting four interpreters to open a `.py` file is not a trade worth
 * making.
 */
export async function interpreterFor(cwd: string): Promise<string | null> {
  // A choice the user made beats anything inferred. Nothing on disk can say
  // "this project uses conda", so detection is a guess and a guess must not
  // override an answer.
  const chosen = chosenInterpreter(cwd);
  if (chosen) return chosen;

  for (const dir of LOCAL_ENVS) {
    const path = join(cwd, dir, "bin", "python");
    if (await exists(path)) return path;
  }
  // Named environments come first out of `condaEnvs`, base last.
  const [conda] = await condaEnvs();
  if (conda) return conda.path;
  return (await which("python3")) ?? (await which("python"));
}

/**
 * Conda environments, from the file conda maintains.
 *
 * Reading `~/.conda/environments.txt` rather than shelling out to `conda info`:
 * the file is authoritative, instant, and does not depend on conda being
 * initialised in this process's shell -- which, in a GUI app launched from
 * Finder, it will not be.
 */
async function condaEnvs(): Promise<{ name: string; path: string }[]> {
  let text: string;
  try {
    text = await readFile(join(homedir(), ".conda", "environments.txt"), "utf8");
  } catch {
    return [];
  }

  const out: { name: string; path: string }[] = [];
  for (const line of text.split("\n")) {
    const root = line.trim();
    if (!root) continue;
    const python = join(root, "bin", "python");
    if (!(await exists(python))) continue;
    // The base install has no `envs/` segment; name it so rather than by its
    // directory, which would read as "miniconda3".
    const name = root.includes("/envs/") ? root.split("/").pop()! : "base";
    out.push({ name, path: python });
  }
  // Named environments before base: base is rarely the one wanted.
  return out.sort((a, b) => Number(a.name === "base") - Number(b.name === "base"));
}

/** Version and debugpy availability, in one interpreter start. */
async function probe(path: string): Promise<{ version?: string; hasDebugpy?: boolean }> {
  try {
    const { stdout } = await run(
      path,
      ["-c", "import sys;\nimport importlib.util as u;\nprint(sys.version.split()[0]);\nprint(u.find_spec('debugpy') is not None)"],
      { timeout: 8000 },
    );
    const [version, debugpy] = stdout.trim().split("\n");
    return { version, hasDebugpy: debugpy?.trim() === "True" };
  } catch {
    // An interpreter that will not start is still listed, without detail.
    return {};
  }
}

async function which(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/which", [name], { timeout: 5000 });
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
