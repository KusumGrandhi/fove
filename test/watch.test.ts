import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchService } from "../src/main/watch.js";

let dir: string;
let svc: WatchService;
let fired: string[];

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-watch-"));
  fired = [];
  svc = new WatchService((d) => fired.push(d));
});

afterEach(async () => {
  svc.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("WatchService", () => {
  test("reports a new file in a watched directory", async () => {
    expect(svc.add(dir)).toBe(true);
    await writeFile(join(dir, "new.txt"), "x");
    await settle();
    expect(fired).toContain(dir);
  });

  test("a burst of writes collapses to one notification", async () => {
    svc.add(dir);
    for (let i = 0; i < 8; i++) await writeFile(join(dir, `f${i}.txt`), "x");
    await settle();
    // Debounced: several events, one callback.
    expect(fired.length).toBe(1);
  });

  test("watching the same directory twice does not double up", () => {
    svc.add(dir);
    svc.add(dir);
    expect(svc.size).toBe(1);
  });

  test("a removed watch stops reporting", async () => {
    svc.add(dir);
    svc.remove(dir);
    await writeFile(join(dir, "after.txt"), "x");
    await settle();
    expect(fired).toEqual([]);
  });

  test("sync keeps only the directories asked for", async () => {
    const other = join(dir, "sub");
    await mkdir(other);
    svc.sync([dir, other]);
    expect(svc.size).toBe(2);
    svc.sync([other]);
    expect(svc.size).toBe(1);

    // The dropped directory is genuinely no longer watched.
    await writeFile(join(dir, "ignored.txt"), "x");
    await settle();
    expect(fired).not.toContain(dir);
  });

  test("a directory that cannot be watched fails soft", () => {
    expect(svc.add(join(dir, "does-not-exist"))).toBe(false);
    expect(svc.size).toBe(0);
  });

  test("closeAll drops everything", async () => {
    svc.add(dir);
    svc.closeAll();
    expect(svc.size).toBe(0);
  });
});
