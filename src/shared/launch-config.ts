/**
 * Reading `.vscode/launch.json`.
 *
 * Deliberately not a fove-specific format: you already have working launch
 * configs, and asking you to restate them here would be a worse tool. Reading
 * the file VS Code already reads means a config that works there works here.
 *
 * The file is **JSONC**, not JSON. `core/.vscode/launch.json` opens with four
 * comment lines, so `JSON.parse` throws on the real file -- which is why the
 * stripper below exists and is tested against the exact shapes that break a
 * naive one: `//` inside a string, `/*` inside a string, and a Windows path's
 * escaped backslash before a quote.
 *
 * Trailing commas are also accepted; VS Code tolerates them and hand-edited
 * configs collect them.
 */

/** One entry from the `configurations` array, narrowed to what is used. */
export interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  /** `python -m <module>`, as core's Flask config uses. */
  module?: string;
  /** A script path, the alternative to `module`. */
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Step into library code as well as your own. Defaults to false. */
  justMyCode?: boolean;
  console?: string;
  /** debugpy attach target. */
  connect?: { host?: string; port?: number };
  port?: number;
  host?: string;
}

/**
 * Remove comments and trailing commas from JSONC.
 *
 * Written as a scanner rather than a regex because the cases that matter are
 * exactly the ones a regex gets wrong: a `//` inside a string literal is not a
 * comment, and a quote inside a comment does not open a string.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;

  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 2; continue; }
      // Newlines are kept so a parse error's line number still means something.
      if (c === "\n") out += c;
      i++;
      continue;
    }
    if (inString) {
      // A backslash escapes the next character, including a quote -- the case
      // that makes a Windows path ("C:\\dir\\") end its string correctly.
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && next === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
    out += c;
    i++;
  }

  // Trailing commas, once comments are gone so a comma inside one cannot count.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The debug configurations in a launch.json.
 *
 * Returns an empty list rather than throwing: a missing or malformed file
 * should leave the debugger offering nothing, not break the pane around it.
 */
export function parseLaunchConfigs(text: string): LaunchConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const list = (parsed as { configurations?: unknown })?.configurations;
  if (!Array.isArray(list)) return [];

  return list.filter(isLaunchConfig);
}

function isLaunchConfig(value: unknown): value is LaunchConfig {
  const c = value as Partial<LaunchConfig> | null;
  return !!c && typeof c.name === "string" && typeof c.type === "string";
}

/** Python configs only: this debugger is Python-only in this round. */
export function pythonConfigs(configs: readonly LaunchConfig[]): LaunchConfig[] {
  // VS Code has used both names for the same thing across versions.
  return configs.filter((c) => c.type === "debugpy" || c.type === "python");
}

/**
 * Expand the `${...}` variables VS Code substitutes.
 *
 * Only the ones that can be resolved without an editor session. An unknown
 * variable is left as written rather than replaced with an empty string:
 * silently emptying a path produces a confusing failure deep in the adapter,
 * where the literal `${foo}` at least says what went wrong.
 */
export function substitute(
  value: string,
  vars: { workspaceFolder: string; file?: string },
): string {
  return value.replace(/\$\{(\w+)\}/g, (whole, name: string) => {
    if (name === "workspaceFolder" || name === "workspaceRoot") return vars.workspaceFolder;
    if (name === "file" && vars.file) return vars.file;
    return whole;
  });
}

/** Apply `substitute` across the fields that can carry a variable. */
export function resolveConfig(
  config: LaunchConfig,
  vars: { workspaceFolder: string; file?: string },
): LaunchConfig {
  const s = (v?: string): string | undefined => (v === undefined ? undefined : substitute(v, vars));
  return {
    ...config,
    program: s(config.program),
    cwd: s(config.cwd),
    args: config.args?.map((a) => substitute(a, vars)),
    env: config.env
      ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, substitute(v, vars)]))
      : undefined,
  };
}
