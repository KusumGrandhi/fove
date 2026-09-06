/**
 * Diagnostics for languages Monaco cannot check itself.
 *
 * Monaco ships a TypeScript/JavaScript language service, so those files are
 * already checked in the renderer. Python has nothing — only syntax
 * highlighting — which is why a `.py` file looked clean no matter what was in
 * it.
 *
 * `ruff` fills that gap: it is already installed here, fast enough to run on
 * every save, and emits JSON with rule codes and exact ranges. It is a linter
 * rather than a type checker, so it will not catch everything a language
 * server would; that is the deliberate trade for something that works today
 * without a stateful protocol.
 *
 * A missing linter is not an error. Most projects do not have one for every
 * language, and a pane that shouts about it would be worse than one that
 * quietly shows no diagnostics.
 */

import { execFile } from "node:child_process";
import { extname } from "node:path";

export interface Diagnostic {
  /** 1-based, as both ruff and Monaco count. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  /** Rule identifier, e.g. "F401". */
  code?: string;
  severity: "error" | "warning" | "info";
}

/** Ruff's JSON shape, narrowed to what is used. */
interface RuffDiagnostic {
  code?: string | null;
  message?: string;
  location?: { row?: number; column?: number };
  end_location?: { row?: number; column?: number };
}

const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Rules that describe style rather than a probable defect.
 *
 * Shown as warnings so a formatting preference does not sit in the editor
 * looking like a bug. `E` is pycodestyle, `W` is warnings, `I` is import
 * order.
 */
const STYLE_PREFIXES = ["E", "W", "I", "D", "Q", "COM"];

function severityFor(code: string | undefined): Diagnostic["severity"] {
  if (!code) return "warning";
  // Syntax errors have no code and everything else is a lint finding; an
  // undefined name (F821) is far more likely to be real than a long line.
  if (code.startsWith("F")) return "error";
  return STYLE_PREFIXES.some((p) => code.startsWith(p)) ? "info" : "warning";
}

export class LintService {
  /** Cached per binary, so a missing linter is probed once rather than per save. */
  private readonly present = new Map<string, boolean>();

  private async has(binary: string): Promise<boolean> {
    const known = this.present.get(binary);
    if (known !== undefined) return known;
    const ok = await new Promise<boolean>((resolve) => {
      execFile(binary, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
    });
    this.present.set(binary, ok);
    return ok;
  }

  /**
   * Diagnostics for one file.
   *
   * Returns an empty list for a language with no configured linter, which the
   * editor renders as "nothing to report" rather than an error.
   */
  async check(path: string, cwd?: string): Promise<Diagnostic[]> {
    if (extname(path) !== ".py") return [];
    if (!(await this.has("ruff"))) return [];
    return this.ruff(path, cwd);
  }

  private ruff(path: string, cwd?: string): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      execFile(
        "ruff",
        ["check", "--output-format=json", "--force-exclude", "--", path],
        { cwd, maxBuffer: MAX_BUFFER, timeout: 20_000 },
        (_err, stdout) => {
          // ruff exits non-zero when it finds problems, which is the normal
          // case here -- the exit code says nothing useful, only the output.
          try {
            const raw = JSON.parse(stdout || "[]") as RuffDiagnostic[];
            resolve(
              raw
                // E902 is an I/O failure -- "no such file", a permission
                // error -- which is about the tool's access, not the code.
                // Surfacing it would put a red squiggle on line 1 of a file
                // that was merely deleted between save and check.
                .filter((r) => r.code !== "E902")
                .map(toDiagnostic)
                .filter((d): d is Diagnostic => d !== null),
            );
          } catch {
            // Malformed output (a ruff crash, a config error) is reported as
            // no diagnostics rather than as a broken editor.
            resolve([]);
          }
        },
      );
    });
  }
}

function toDiagnostic(r: RuffDiagnostic): Diagnostic | null {
  const line = r.location?.row;
  const column = r.location?.column;
  if (typeof line !== "number" || typeof column !== "number") return null;
  const code = r.code ?? undefined;
  return {
    line,
    column,
    // A diagnostic with no end collapses to a single character rather than
    // underlining to the end of the file.
    endLine: r.end_location?.row ?? line,
    endColumn: r.end_location?.column ?? column + 1,
    message: r.message ?? "",
    code,
    severity: severityFor(code),
  };
}
