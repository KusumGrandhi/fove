/**
 * The backend a plain `claude` pane starts on.
 *
 * Without this, choosing a provider is a per-pane act that has to be repeated
 * every time, and the picker is the only way to reach a non-Anthropic model. A
 * saved default makes the choice stick across launches: every claude pane that
 * was not pointed somewhere explicitly starts here instead.
 *
 * Only the provider id and model name are stored. The key is resolved at spawn
 * time, so a default naming a provider whose key has since been forgotten
 * degrades to "unusable" in the picker rather than to a broken pane.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_MODEL_PATH = join(homedir(), ".config", "fove", "default-model.json");

export interface DefaultModel {
  providerId: string;
  /** Empty means "the provider's own default model". */
  model: string;
}

/** The saved default, or null when panes should start on plain Anthropic. */
export async function loadDefaultModel(path = DEFAULT_MODEL_PATH): Promise<DefaultModel | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!raw || typeof raw.providerId !== "string" || !raw.providerId) return null;
    return { providerId: raw.providerId, model: typeof raw.model === "string" ? raw.model : "" };
  } catch {
    return null;
  }
}

/** Save the default, or clear it by passing null. */
export async function saveDefaultModel(
  next: DefaultModel | null,
  path = DEFAULT_MODEL_PATH,
): Promise<void> {
  if (!next) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}
