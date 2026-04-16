/**
 * One-shot migrator: move runtime state from `.claude/claudeclaw/` into the
 * new `.claude/hermes/` layout on first boot after the rename.
 *
 * Contract:
 *   - Idempotent: running twice does nothing the second time.
 *   - Non-destructive up to a point: source is renamed (not deleted) so the
 *     user can recover if something surprising happens.
 *   - Writes a MIGRATED.json marker with timestamps + file count.
 *   - Rewrites the CLAUDE.md managed-block markers from the legacy name to
 *     the new one so subsequent `ensureProjectClaudeMd` calls track the block
 *     correctly.
 *
 * Call exactly once from the daemon startup path, before anything else
 * touches state files. `migrateIfNeeded()` is safe to call on every boot —
 * it short-circuits when the new dir already exists.
 */

import { cp, readFile, rename, stat, writeFile } from "node:fs/promises";
import {
  LEGACY_MANAGED_BLOCK_END,
  LEGACY_MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  hermesDir,
  legacyDir,
  migrationMarkerFile,
} from "../paths";
import { join } from "node:path";

export interface MigrationResult {
  status: "skipped" | "migrated" | "conflict";
  reason: string;
  source?: string;
  target?: string;
  filesCopied?: number;
  archivedAs?: string;
  claudeMdRewritten?: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function countEntries(root: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        count++;
      }
    }
  }
  await walk(root);
  return count;
}

async function rewriteProjectClaudeMd(cwd: string): Promise<boolean> {
  const path = join(cwd, "CLAUDE.md");
  if (!(await pathExists(path))) return false;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return false;
  }
  if (!content.includes(LEGACY_MANAGED_BLOCK_START) && !content.includes(LEGACY_MANAGED_BLOCK_END)) {
    return false;
  }
  const updated = content
    .split(LEGACY_MANAGED_BLOCK_START)
    .join(MANAGED_BLOCK_START)
    .split(LEGACY_MANAGED_BLOCK_END)
    .join(MANAGED_BLOCK_END);
  if (updated === content) return false;
  await writeFile(path, updated, "utf8");
  return true;
}

export async function migrateIfNeeded(cwd: string = process.cwd()): Promise<MigrationResult> {
  const source = legacyDir(cwd);
  const target = hermesDir(cwd);
  const marker = migrationMarkerFile(cwd);

  const [hasSource, hasTarget] = await Promise.all([pathExists(source), pathExists(target)]);

  if (!hasSource) {
    return { status: "skipped", reason: "no legacy directory found" };
  }

  if (hasTarget && (await pathExists(marker))) {
    return { status: "skipped", reason: "already migrated", source, target };
  }

  if (hasTarget) {
    return {
      status: "conflict",
      reason: "both legacy and new dirs exist; refusing to overwrite without MIGRATED marker",
      source,
      target,
    };
  }

  const startedAt = new Date();
  await cp(source, target, { recursive: true });
  const filesCopied = await countEntries(target);

  const claudeMdRewritten = await rewriteProjectClaudeMd(cwd);

  const archivedAs = `${source}.migrated-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  await rename(source, archivedAs);

  const markerBody = {
    migratedAt: startedAt.toISOString(),
    source,
    target,
    archivedAs,
    filesCopied,
    claudeMdRewritten,
    version: 1,
  };
  await writeFile(marker, JSON.stringify(markerBody, null, 2) + "\n", "utf8");

  return {
    status: "migrated",
    reason: `${filesCopied} file(s) copied`,
    source,
    target,
    filesCopied,
    archivedAs,
    claudeMdRewritten,
  };
}
