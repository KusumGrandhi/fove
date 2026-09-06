/**
 * Directory watching, so the tree reflects what an agent just did.
 *
 * Without this the tree only refreshes when you navigate, and — worse — the
 * editor's mtime guard rejects a save with a conflict because the file changed
 * underneath it. Both are constant here: an agent editing files is the normal
 * case, not the exception.
 *
 * Deliberately shallow (one directory, not a tree). A recursive watch on a
 * repository like `core` means thousands of descriptors and a flood of events
 * from `node_modules` and `.git`, to keep a file list current that only shows
 * one directory anyway.
 *
 * Events are debounced and coalesced: a single save can emit several
 * (`rename` then `change`), and the consumer only needs "this directory
 * changed, look again".
 */

import { watch, type FSWatcher } from "node:fs";

/** Long enough to swallow an editor's write burst, short enough to feel live. */
const DEBOUNCE_MS = 120;

interface Entry {
  watcher: FSWatcher;
  timer?: NodeJS.Timeout;
}

export class WatchService {
  private readonly watching = new Map<string, Entry>();

  constructor(private readonly onChange: (dir: string) => void) {}

  /**
   * Watch a directory, replacing any previous watch on it.
   *
   * Returns false when the directory cannot be watched — a path that vanished,
   * or a platform limit — which the caller should treat as "no live updates
   * here" rather than an error worth showing.
   */
  add(dir: string): boolean {
    if (this.watching.has(dir)) return true;
    try {
      const watcher = watch(dir, { persistent: false }, () => {
        const entry = this.watching.get(dir);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.onChange(dir), DEBOUNCE_MS);
      });
      // A watched directory that is deleted emits an error rather than an
      // event; drop the watch instead of leaving a dead one behind.
      watcher.on("error", () => this.remove(dir));
      this.watching.set(dir, { watcher });
      return true;
    } catch {
      return false;
    }
  }

  remove(dir: string): void {
    const entry = this.watching.get(dir);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      // Already closed.
    }
    this.watching.delete(dir);
  }

  /**
   * Watch exactly this set of directories, dropping the rest.
   *
   * The editor calls this as the user navigates, so watches follow what is on
   * screen instead of accumulating for the life of the app.
   */
  sync(dirs: string[]): void {
    const wanted = new Set(dirs);
    for (const dir of [...this.watching.keys()]) {
      if (!wanted.has(dir)) this.remove(dir);
    }
    for (const dir of wanted) this.add(dir);
  }

  get size(): number {
    return this.watching.size;
  }

  closeAll(): void {
    for (const dir of [...this.watching.keys()]) this.remove(dir);
  }
}
