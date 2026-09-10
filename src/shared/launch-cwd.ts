/**
 * Which folder a workspace opens in when nobody said.
 *
 * `process.cwd()` is the right answer when fove is started from a terminal,
 * and useless when it is not: a Finder- or Spotlight-launched macOS app
 * inherits `/`, so a first run opened a workspace on the filesystem root --
 * an editor tree of /Applications and /System, a shell in /, and no git
 * repository anywhere in sight.
 *
 * Pure, so the precedence is testable without launching an app from Finder.
 */

/** A directory that cannot be what anyone meant. */
function isUseless(dir: string | undefined): boolean {
  if (!dir) return true;
  const d = dir.trim();
  // "/" is what Finder gives. "." and "" are what a broken shell gives.
  return d === "" || d === "/" || d === ".";
}

/**
 * Pick a launch directory, most-specific first.
 *
 * 1. the real working directory, when there is one -- someone who ran
 *    `fove` in a project meant that project, and nothing should override it;
 * 2. the folder of the last workspace they had open, which is the best
 *    available guess at what they work on;
 * 3. home, which is at least a place with their files in it.
 *
 * `recent` is passed in rather than read here so this stays pure; the caller
 * takes it from the persisted layout it already loads.
 */
export function launchCwd(opts: {
  cwd?: string;
  /** Workspace directories from the saved layout, most recent first. */
  recent?: (string | undefined)[];
  home: string;
}): string {
  if (!isUseless(opts.cwd)) return opts.cwd!.trim();
  const recent = (opts.recent ?? []).find((d) => !isUseless(d));
  if (recent) return recent.trim();
  return opts.home;
}
