/**
 * Symbols for the languages Monaco has no language service for.
 *
 * Monaco ships outline providers for TypeScript, JavaScript, JSON, HTML and
 * CSS, and nothing for anything else -- so ⌘⇧O in a Python file opened an
 * empty picker, which reads as broken rather than as unsupported.
 *
 * This is a scanner, not a parser. It reads declarations off the front of a
 * line and nothing else. That is a deliberate ceiling: a real outline needs a
 * language server, and one is not worth standing up for the question "what
 * functions are in this file" -- but a wrong answer *is* worse than no answer,
 * so it only claims what the syntax makes unambiguous.
 *
 * What it therefore does not see: anything defined inside a string or a
 * comment block, decorators, and symbols produced by a macro. Those are all
 * cases where guessing would put a name in the list that is not in the file.
 */

export type SymbolKind =
  | "class" | "function" | "method" | "constant"
  | "struct" | "interface" | "enum" | "module" | "trait";

export interface ScannedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, as editors count. */
  line: number;
  /** Last line of the symbol's body, inclusive. */
  endLine: number;
  /** Shown beside the name: a signature fragment, a receiver type. */
  detail?: string;
  children: ScannedSymbol[];
}

/** Languages this scanner claims. Others get nothing rather than a guess. */
export const SCANNED_LANGUAGES = ["python", "go", "rust", "ruby"] as const;

export function scanSymbols(language: string, text: string): ScannedSymbol[] {
  const lines = text.split("\n");
  switch (language) {
    case "python": return python(lines);
    case "go": return go(lines);
    case "rust": return rust(lines);
    case "ruby": return ruby(lines);
    default: return [];
  }
}

/** Leading whitespace width, tabs counted as one level of four. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Python, nested by indentation.
 *
 * Indentation *is* the structure here, so a method inside a class comes out
 * as a child of it rather than as another top-level entry -- which is the
 * whole difference between an outline and a list of every `def` in the file.
 */
function python(lines: string[]): ScannedSymbol[] {
  const root: ScannedSymbol[] = [];
  /** Open symbols, outermost first, with the indent each was declared at. */
  const stack: { indent: number; sym: ScannedSymbol }[] = [];

  const close = (indent: number, upTo: number) => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()!.sym.endLine = upTo;
    }
  };

  lines.forEach((raw, i) => {
    const line = i + 1;
    const body = raw.trim();
    if (!body || body.startsWith("#")) return;

    const indent = indentOf(raw);
    const def = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(body);
    const cls = /^class\s+([A-Za-z_]\w*)/.exec(body);
    // Module-level constants only: a SCREAMING name indented inside a function
    // is a local, and listing it would bury the functions it sits between.
    const konst = indent === 0 ? /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/.exec(body) : null;

    if (!def && !cls && !konst) return;
    close(indent, line - 1);

    const parent = stack[stack.length - 1]?.sym;
    const sym: ScannedSymbol = def
      ? {
          name: def[2]!,
          // A def whose parent is a class is a method; the distinction is what
          // makes the picker's grouping mean anything.
          kind: parent?.kind === "class" ? "method" : "function",
          line, endLine: line, children: [],
          detail: def[1] ? "async" : undefined,
        }
      : cls
        ? { name: cls[1]!, kind: "class", line, endLine: line, children: [] }
        : { name: konst![1]!, kind: "constant", line, endLine: line, children: [] };

    if (parent) parent.children.push(sym);
    else root.push(sym);
    // A constant has no body to hold children.
    if (!konst) stack.push({ indent, sym });
  });

  close(0, lines.length);
  for (const s of stack) s.sym.endLine = lines.length;
  return root;
}

/**
 * Brace languages: flat, with each symbol running to the next one.
 *
 * Counting braces to find a real end would mean handling strings, comments
 * and character literals -- a parser's job. The end line only decides what
 * gets highlighted on a jump, so "up to the next declaration" is close enough
 * to be useful and cannot be wrong in a way that matters.
 */
function flat(
  lines: string[],
  match: (body: string) => { name: string; kind: SymbolKind; detail?: string } | null,
): ScannedSymbol[] {
  const out: ScannedSymbol[] = [];
  lines.forEach((raw, i) => {
    const body = raw.trim();
    if (!body || body.startsWith("//") || body.startsWith("#")) return;
    const hit = match(body);
    if (!hit) return;
    const prev = out[out.length - 1];
    if (prev) prev.endLine = i;
    out.push({ ...hit, line: i + 1, endLine: lines.length, children: [] });
  });
  return out;
}

function go(lines: string[]): ScannedSymbol[] {
  return flat(lines, (body) => {
    // A method carries its receiver, which is the only thing telling two
    // `String()` implementations apart in a list.
    const method = /^func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/.exec(body);
    if (method) return { name: method[2]!, kind: "method", detail: method[1] };
    const fn = /^func\s+([A-Za-z_]\w*)/.exec(body);
    if (fn) return { name: fn[1]!, kind: "function" };
    const type = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(body);
    if (type) return { name: type[1]!, kind: type[2] === "struct" ? "struct" : "interface" };
    return null;
  });
}

function rust(lines: string[]): ScannedSymbol[] {
  return flat(lines, (body) => {
    const fn = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/.exec(body);
    if (fn) return { name: fn[1]!, kind: "function" };
    const impl = /^impl(?:<[^>]*>)?\s+(?:([A-Za-z_]\w*)(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/.exec(body);
    if (impl) return { name: impl[2]!, kind: "module", detail: impl[1] ? `impl ${impl[1]}` : "impl" };
    const decl = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/.exec(body);
    if (decl) {
      const kind = decl[1] === "struct" ? "struct" : decl[1] === "enum" ? "enum" : "trait";
      return { name: decl[2]!, kind };
    }
    return null;
  });
}

function ruby(lines: string[]): ScannedSymbol[] {
  return flat(lines, (body) => {
    const def = /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/.exec(body);
    if (def) return { name: def[1]!, kind: "method" };
    const cls = /^class\s+([A-Za-z_][\w:]*)/.exec(body);
    if (cls) return { name: cls[1]!, kind: "class" };
    const mod = /^module\s+([A-Za-z_][\w:]*)/.exec(body);
    if (mod) return { name: mod[1]!, kind: "module" };
    return null;
  });
}
