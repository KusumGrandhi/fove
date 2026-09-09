/**
 * The exported surface of a file, extracted rather than authored.
 *
 * Rule 2 of the handoff: *a file card is generated, never authored*. That is
 * what makes a card immune to going stale -- there is nothing on it for anyone
 * to maintain. The contract half of that card comes from here.
 *
 * An earlier version of the v0.9 plan called this blocked, on the grounds that
 * `core` annotates only 39% of return types. That was wrong, and the mistake is
 * worth recording: the *exported surface* does not depend on annotations at
 * all. `ast` yields names, parameters, and whatever types are present, on every
 * file that parses -- measured at **120/120 sampled files parsed, 75% with a
 * public surface**. A partial contract is still a contract.
 *
 * Python is parsed by Python. A hand-rolled parser in JS would be wrong on
 * exactly the files worth reading, and `ast` is both correct and already on the
 * machine. TypeScript and JavaScript are parsed here in-process, since the
 * cases that matter are simple and a second toolchain is not worth it.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface ContractEntry {
  kind: "function" | "class" | "constant";
  name: string;
  /** The signature as it would be written, e.g. `bandFor(score: int) -> Band`. */
  signature: string;
  line: number;
  /** First line of the docstring, when there is one. */
  summary?: string;
}

export interface FileContract {
  path: string;
  language: "python" | "typescript" | "unknown";
  entries: ContractEntry[];
  /** Why the surface is empty, when it is. Distinguishes "none" from "failed". */
  note?: string;
}

/**
 * The Python side, as a script fed to the interpreter on stdin.
 *
 * Written out rather than imported because it has to reach whichever
 * interpreter is available, and shipping it as a string keeps it in one file
 * with the code that reads its output.
 *
 * Only module-level, non-underscore names: those are the exported surface. A
 * nested helper is an implementation detail and putting it on the card would
 * bury the three things that matter under thirty that do not.
 */
const PY_EXTRACT = `
import ast, json, sys

def sig(n):
    parts = []
    a = n.args
    for i, arg in enumerate(a.args):
        s = arg.arg
        if arg.annotation is not None:
            s += ": " + ast.unparse(arg.annotation)
        parts.append(s)
    if a.vararg: parts.append("*" + a.vararg.arg)
    if a.kwarg: parts.append("**" + a.kwarg.arg)
    ret = " -> " + ast.unparse(n.returns) if n.returns else ""
    return n.name + "(" + ", ".join(parts) + ")" + ret

def summary(n):
    d = ast.get_docstring(n)
    return d.strip().split("\\n")[0] if d else None

out = []
try:
    tree = ast.parse(sys.stdin.read())
except SyntaxError as e:
    print(json.dumps({"error": "syntax error on line %s" % e.lineno}))
    sys.exit(0)

for n in tree.body:
    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if n.name.startswith("_"): continue
        out.append({"kind": "function", "name": n.name, "signature": sig(n),
                    "line": n.lineno, "summary": summary(n)})
    elif isinstance(n, ast.ClassDef):
        if n.name.startswith("_"): continue
        bases = [ast.unparse(b) for b in n.bases]
        s = n.name + ("(" + ", ".join(bases) + ")" if bases else "")
        out.append({"kind": "class", "name": n.name, "signature": s,
                    "line": n.lineno, "summary": summary(n)})
    elif isinstance(n, ast.Assign):
        # Module constants: UPPER_CASE only. Everything else at module level is
        # usually incidental state rather than part of the surface.
        for t in n.targets:
            if isinstance(t, ast.Name) and t.id.isupper() and not t.id.startswith("_"):
                out.append({"kind": "constant", "name": t.id, "signature": t.id,
                            "line": n.lineno, "summary": None})

print(json.dumps(out))
`;

/**
 * Run a command with source on stdin.
 *
 * `execFile` has no stdin, and the source has to arrive that way -- passing a
 * file path instead would make the extractor read from disk and miss unsaved
 * edits, which is exactly the state a card is most often looked at in.
 */
function runWithInput(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("extractor timed out")); }, 8000);
    let out = "";
    let size = 0;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { child.kill(); reject(new Error("output too large")); return; }
      out += c.toString();
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`extractor exited ${code}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

/** Run the extractor with a specific interpreter. */
async function extractPython(
  source: string,
  python: string,
): Promise<{ entries: ContractEntry[]; note?: string }> {
  try {
    const stdout = await runWithInput(python, ["-c", PY_EXTRACT], source);
    const parsed = JSON.parse(stdout) as ContractEntry[] | { error: string };
    if (!Array.isArray(parsed)) return { entries: [], note: parsed.error };
    return { entries: parsed };
  } catch {
    return { entries: [], note: "could not run the Python extractor" };
  }
}

/**
 * Top-level exported declarations in a TypeScript or JavaScript file.
 *
 * A regex rather than a real parser: this reads one line at a time and does
 * not try to be a TypeScript compiler. Missing something shows fewer entries,
 * which is a smaller failure than pulling in a second toolchain.
 *
 * But *silently* showing none is not a small failure -- it reads as "this file
 * exports nothing", which is a claim, and a false one. The first version was
 * written against fove's own source and missed two shapes that dominate real
 * codebases: measured on `core`'s frontend, **770 of 1777 files** use
 * `export default` and rendered as "nothing exported".
 *
 * So the patterns cover what people actually write, not what this project
 * happens to:
 *
 *   - `export default Foo` and `export default function/class`
 *   - `export const Foo = ...` at any casing -- the original required
 *     SCREAMING_CASE, which excluded every React component
 *   - `export { a, b }` re-export lists
 */
function extractTypeScript(source: string): ContractEntry[] {
  const entries: ContractEntry[] = [];
  const lines = source.split("\n");

  const patterns: [RegExp, ContractEntry["kind"]][] = [
    [/^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)[^{]*)/, "function"],
    [/^export\s+(?:abstract\s+)?class\s+(\w+)([^{]*)/, "class"],
    [/^export\s+(?:interface|type|enum)\s+(\w+)/, "class"],
    // `export default function Foo()` / `export default class Foo`, then the
    // bare `export default Foo` that a component file ends with.
    // The parameter list may not close on this line -- `({` opening a
    // destructured props object is how most components are written -- so the
    // signature capture is optional here.
    [/^export\s+default\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)[^{]*)?/, "function"],
    [/^export\s+default\s+(?:abstract\s+)?class\s+(\w+)([^{]*)/, "class"],
    // `export default forwardRef<...>(function Foo(` and friends: the name
    // worth showing is the inner function's, not the wrapper's.
    [/^export\s+default\s+\w+(?:<[^>]*>)?\(\s*(?:async\s+)?function\s+(\w+)/, "function"],
    // `export default slice.reducer` -- a member expression, named by its tail.
    [/^export\s+default\s+\w+\.(\w+)\s*;?\s*$/, "constant"],
    // `export default memo(Foo)` / `React.memo(Foo)` -- a wrapper around a
    // component declared above. The wrapped name is the export's identity.
    [/^export\s+default\s+(?:\w+\.)?\w+\(\s*(\w+)\s*\)\s*;?\s*$/, "constant"],
    [/^export\s+default\s+(\w+)\s*;?\s*$/, "constant"],
    // Any exported const, not only SCREAMING_CASE: a React component, a hook
    // and an arrow function are all written this way.
    [/^export\s+const\s+(\w+)\s*[:=]/, "constant"],
    // `export const { a, b } = slice.actions` -- destructured, several names.
    // Handled below with the re-export lists, which share the shape.
    [/^export\s+(?:let|var)\s+(\w+)\s*[:=]/, "constant"],
  ];

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();

    /*
     * `export { a, b as c }` -- a re-export list, which is the whole public
     * surface of a barrel file. One line, several names, so it cannot be one
     * of the single-capture patterns above.
     *
     * `export type { ... }` is skipped: it re-exports types that are already
     * declared somewhere the extractor will find them.
     */
    const list = /^export\s+(?:const\s+)?\{([^}]*)\}/.exec(line);
    if (list && !/^export\s+type\s/.test(line)) {
      for (const part of list[1]!.split(",")) {
        // `a as b` exports under the second name.
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        // `export { default } from "./X"` is a barrel re-export: the name is
        // literally `default`, and saying so beats reporting nothing.
        if (name && /^\w+$/.test(name)) {
          entries.push({ kind: "constant", name, signature: name, line: i + 1 });
        }
      }
      return;
    }

    for (const [re, kind] of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      entries.push({
        kind,
        name: m[1]!,
        signature: (m[1]! + (m[2] ?? "")).trim().replace(/\s+/g, " ").slice(0, 160),
        line: i + 1,
      });
      break;
    }
  });

  /*
   * A default export whose name is only on the *next* line.
   *
   * `export default forwardRef<Props>(\n  function Foo(` is common enough in
   * this codebase to matter, and a line-at-a-time reader cannot see it. Rather
   * than grow into a parser, record that the file has a default export and let
   * the card say so -- "exports a component" is worth far more than the
   * "nothing exported" this used to claim.
   */
  if (entries.length === 0 && /^export\s+default\b/m.test(source)) {
    const line = lines.findIndex((l) => /^export\s+default\b/.test(l)) + 1;
    entries.push({
      kind: "constant",
      name: "default",
      signature: "default export",
      line: line > 0 ? line : 1,
    });
  }

  return entries;
}

/**
 * Read a file's exported surface.
 *
 * `python` names the interpreter to use; without one, Python files report that
 * rather than silently returning nothing -- an empty card and an unavailable
 * extractor look identical and mean opposite things.
 */
export async function fileContract(path: string, python?: string): Promise<FileContract> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return { path, language: "unknown", entries: [], note: "could not read the file" };
  }

  const ext = extname(path).toLowerCase();

  if (ext === ".py") {
    if (!python) {
      return { path, language: "python", entries: [], note: "no Python interpreter available" };
    }
    const { entries, note } = await extractPython(source, python);
    return { path, language: "python", entries, note };
  }

  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(ext)) {
    return { path, language: "typescript", entries: extractTypeScript(source) };
  }

  return { path, language: "unknown", entries: [], note: `no extractor for ${ext || "this file"}` };
}
