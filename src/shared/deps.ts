/**
 * What fove needs on the machine, and how to read a check's result.
 *
 * fove is a shell around command-line tools rather than a self-contained
 * application: a claude pane is the real `claude`, the git pane is real `git`,
 * a teammate tab is a real tmux pane. So "is it installed" is a first-class
 * question, and one the app should answer plainly instead of letting a pane
 * fail silently.
 *
 * Pure data and pure functions, no child_process and no Electron, so the
 * severity rules and the summary are testable without a machine that happens
 * to be missing tmux.
 */

/** How much of fove stops working without this. */
export type DepSeverity =
  /** The app is pointless without it. */
  | "required"
  /** A whole pane or feature is dead, the rest is fine. */
  | "feature"
  /** A convenience; there is another way to do the same thing. */
  | "optional";

export interface Dep {
  /** The binary to look for on PATH. */
  bin: string;
  /** What it is called in prose. */
  label: string;
  severity: DepSeverity;
  /** What breaks without it, phrased for someone reading a list. */
  needs: string;
  /** Homebrew formula, when there is one. */
  brew?: string;
  /** Where to get it when brew is not the answer. */
  url?: string;
  /** Argument that makes it print a version, for the check. */
  versionArg?: string;
  /**
   * Other binaries that do the same job. Any one of them satisfies this dep.
   *
   * `bin` stays the one the sheet offers to install -- the recommendation --
   * while these are merely accepted. A machine with jedi-language-server has
   * working Python go-to-definition, and a doctor that told it to install
   * pyright anyway would be reporting a problem the user does not have.
   */
  alternatives?: string[];
}

/**
 * The dependencies, in the order a reader should meet them.
 *
 * Ordered by severity rather than alphabetically: someone scanning this list
 * is trying to find out whether the app will work, and the answer is at the
 * top.
 */
export const DEPS: Dep[] = [
  {
    bin: "claude",
    label: "Claude Code",
    severity: "required",
    needs: "every claude pane. This is the app's reason to exist.",
    url: "https://claude.com/claude-code",
    versionArg: "--version",
  },
  {
    bin: "git",
    label: "git",
    severity: "required",
    needs: "the git pane, worktrees, diffs and the commit graph.",
    brew: "git",
    versionArg: "--version",
  },
  {
    bin: "tmux",
    label: "tmux",
    severity: "feature",
    needs: "teammate tabs. Without it a swarm is never even detected.",
    brew: "tmux",
    versionArg: "-V",
  },
  {
    bin: "rg",
    label: "ripgrep",
    severity: "feature",
    needs: "the search pane.",
    brew: "ripgrep",
    versionArg: "--version",
  },
  {
    /*
     * The binary the editor actually spawns, not the `pyright` CLI beside it.
     * They ship together, but naming the checker here would let the doctor
     * report a tick while the editor still found nothing to talk to.
     *
     * No versionArg on purpose: `pyright-langserver --version` exits non-zero,
     * because it wants a transport flag instead. The doctor would survive that
     * -- it locates with `command -v` and treats a refused version as
     * uncommunicative-but-present -- but there is no point spending an exec
     * and up to five seconds of timeout to learn nothing.
     */
    bin: "pyright-langserver",
    label: "Pyright",
    severity: "feature",
    needs:
      "go-to-definition, find-references, rename and hover in Python. Without it .py files keep highlighting, ruff diagnostics and the outline.",
    brew: "pyright",
    url: "https://microsoft.github.io/pyright/#/installation",
    // The rest of the table in main/lsp.ts, which the editor tries in this
    // order. Held to that list by test/deps.test.ts.
    alternatives: ["basedpyright-langserver", "jedi-language-server", "pylsp"],
  },
  {
    bin: "code",
    label: "VS Code CLI",
    severity: "optional",
    needs: "the “open in VS Code” buttons. fove's own editor does the same job.",
    url: "https://code.visualstudio.com/docs/setup/mac#_launching-from-the-command-line",
    versionArg: "--version",
  },
];

/** The result of looking for one dependency. */
export interface DepStatus {
  bin: string;
  /** Resolved path, when found. */
  path?: string;
  /** First line of its version output, when it gave one. */
  version?: string;
}

export interface DepReport {
  dep: Dep;
  status: DepStatus;
  found: boolean;
}

/**
 * Join the spec to what was found on disk.
 *
 * The status carried back is whichever binary actually satisfied the dep, so
 * a row for a dep met by an alternative shows that alternative's path and
 * version rather than a blank where the recommended one would have been.
 */
export function report(statuses: DepStatus[]): DepReport[] {
  const byBin = new Map(statuses.map((s) => [s.bin, s]));
  return DEPS.map((dep) => {
    const own = byBin.get(dep.bin) ?? { bin: dep.bin };
    if (own.path) return { dep, status: own, found: true };
    for (const alt of dep.alternatives ?? []) {
      const status = byBin.get(alt);
      if (status?.path) return { dep, status, found: true };
    }
    return { dep, status: own, found: false };
  });
}

/**
 * One line describing the machine's readiness.
 *
 * Deliberately says nothing when everything is present: a setup screen that
 * congratulates you on every launch is noise. The caller renders nothing for
 * a null summary.
 */
export function summary(reports: DepReport[]): string | null {
  const missing = reports.filter((r) => !r.found);
  if (missing.length === 0) return null;

  const bySeverity = (s: DepSeverity) =>
    missing.filter((r) => r.dep.severity === s).map((r) => r.dep.label);

  const required = bySeverity("required");
  if (required.length > 0) {
    return `${required.join(" and ")} ${required.length === 1 ? "is" : "are"} missing. fove cannot work without ${required.length === 1 ? "it" : "them"}.`;
  }

  const feature = bySeverity("feature");
  if (feature.length > 0) {
    return `${feature.join(", ")} missing — those features are unavailable.`;
  }

  return `${bySeverity("optional").join(", ")} missing — optional.`;
}

/**
 * Whether the app is usable at all.
 *
 * Only a missing `required` dependency is fatal. A machine with no tmux is
 * a machine without teammate tabs, not a broken install, and saying otherwise
 * would train the reader to ignore the warning.
 */
export function isUsable(reports: DepReport[]): boolean {
  return !reports.some((r) => !r.found && r.dep.severity === "required");
}

/** The command that installs a dependency, or null when there isn't one. */
export function installCommand(dep: Dep): string | null {
  return dep.brew ? `brew install ${dep.brew}` : null;
}
