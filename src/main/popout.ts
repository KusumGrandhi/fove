/**
 * Pop a pane into its own window, for a second screen.
 *
 * The design constraint is the whole feature: **do not remount the pane**. A
 * PTY belongs to the main process and is addressed by pane id, so a second
 * window can attach to the *same* session — replaying the scrollback the PTY
 * service already retains and receiving the same `pty:data` events — instead
 * of spawning a new one. Tearing down and respawning would kill a running
 * `claude`, which is exactly the session you most want on the other screen.
 *
 * Native view reparenting was rejected: fragile across platforms, and it buys
 * nothing over a second window rendering the same pane id.
 *
 * The window loads the same renderer with `?popout=<paneId>`, so there is one
 * bundle and one code path rather than a second, thinner UI that would drift.
 */

import { BrowserWindow } from "electron";
import { join } from "node:path";

export interface PopoutState {
  paneId: string;
  /** Remembered so a popped window reopens where the user put it. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export class PopoutService {
  private readonly windows = new Map<string, BrowserWindow>();

  /**
   * `onClosed` fires when the user closes a popped window, so the layout can
   * put the pane back rather than leaving a hole where it used to be.
   */
  constructor(private readonly onClosed: (paneId: string) => void) {}

  has(paneId: string): boolean {
    const w = this.windows.get(paneId);
    return !!w && !w.isDestroyed();
  }

  /** Every pane currently in its own window. */
  list(): string[] {
    return [...this.windows.entries()]
      .filter(([, w]) => !w.isDestroyed())
      .map(([id]) => id);
  }

  /**
   * Open (or focus) a window for one pane.
   *
   * Focusing an existing window rather than opening a second is deliberate:
   * two windows on one PTY would both be live and both echo, which reads as a
   * bug.
   */
  open(paneId: string, title: string, bounds?: PopoutState["bounds"]): void {
    const existing = this.windows.get(paneId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const w = new BrowserWindow({
      width: bounds?.width ?? 900,
      height: bounds?.height ?? 620,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 360,
      minHeight: 240,
      title,
      backgroundColor: "#101014",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const query = `popout=${encodeURIComponent(paneId)}`;
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) void w.loadURL(`${devUrl}?${query}`);
    else void w.loadFile(join(__dirname, "../../renderer/index.html"), { search: query });

    w.on("closed", () => {
      this.windows.delete(paneId);
      this.onClosed(paneId);
    });

    this.windows.set(paneId, w);
  }

  /** Close a popped window without treating it as the user putting the pane back. */
  close(paneId: string): void {
    const w = this.windows.get(paneId);
    this.windows.delete(paneId);
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** Where each popped window sits, so the arrangement survives a restart. */
  bounds(): PopoutState[] {
    return [...this.windows.entries()]
      .filter(([, w]) => !w.isDestroyed())
      .map(([paneId, w]) => {
        const b = w.getBounds();
        return { paneId, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } };
      });
  }

  closeAll(): void {
    for (const paneId of [...this.windows.keys()]) this.close(paneId);
  }
}
