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
 * A regex rather than a real parser, and the limitation is deliberate: this
 * reads *fove's own* source, where exports are one per line and conventional.
 * It is not trying to be a TypeScript compiler -- if it misses something the
 * card shows fewer entries, which is a smaller failure than pulling in a second
 * toolchain to be exhaustive about a case that barely arises.
 */
function extractTypeScript(source: string): ContractEntry[] {
  const entries: ContractEntry[] = [];
  const lines = source.split("\n");

  const patterns: [RegExp, ContractEntry["kind"]][] = [
    [/^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)[^{]*)/, "function"],
    [/^export\s+(?:abstract\s+)?class\s+(\w+)([^{]*)/, "class"],
    [/^export\s+(?:interface|type)\s+(\w+)/, "class"],
    [/^export\s+const\s+([A-Z_][A-Z0-9_]*)\s*[:=]/, "constant"],
  ];

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
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
