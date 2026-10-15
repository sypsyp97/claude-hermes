/**
 * Voyager-style skill library: read/write skill directories on disk plus a
 * JSONL trajectory log, and surface skills via the FTS5 index registered by
 * migration 003. Each skill lives at `.claude/hermes/skills/<name>/` and owns
 * three files:
 *
 *   - `SKILL.md`         — the skill body the model executes against.
 *   - `description.txt`  — the imperative one-liner the FTS index ranks.
 *   - `trajectory.jsonl` — append-only JSONL log of tool calls + outcomes.
 *
 * The FTS5 table is a plain (non-content-table) index: there is no SQL source
 * table to trigger off, so `writeSkill` keeps it in lockstep with disk by
 * doing an explicit DELETE + INSERT under the skill name.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSharedDb } from "../state/shared-db";
import type { Database } from "../state/db";
import { getSkill, upsertSkill } from "../state/repos/skills";
import { validateSkillManifest } from "./validate";
import { assertSkillPathSegment } from "./path";

export interface TrajectoryEntry {
  ts: string;
  tool: string;
  ok: boolean;
  note?: string;
}

export interface SkillFiles {
  skillMd: string;
  description: string;
  trajectory: TrajectoryEntry[];
}

function skillsRoot(cwd: string): string {
  return join(cwd, ".claude", "hermes", "skills");
}

function skillDir(cwd: string, name: string): string {
  assertSkillPathSegment(name);
  return join(skillsRoot(cwd), name);
}

/**
 * Pull the `description:` value out of an optional YAML frontmatter block.
 * The frontmatter is the leading `---\n...\n---\n` segment. We do not pull
 * in a YAML dependency: the format we emit is single-line key/value pairs,
 * and that is all we need to parse on read-back.
 *
 * Returns `null` when no frontmatter or no `description` key is present.
 */
function extractFrontmatterDescription(skillMd: string): string | null {
  if (!skillMd.startsWith("---\n")) return null;
  const end = skillMd.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const block = skillMd.slice(4, end);
  const match = block.match(/^description:\s*(.+)$/m);
  if (!match) return null;
  return match[1]!.trim();
}

export async function readSkill(
  name: string,
  cwd: string = process.cwd(),
): Promise<SkillFiles | null> {
  const dir = skillDir(cwd, name);
  if (!existsSync(dir)) return null;

  const skillMdPath = join(dir, "SKILL.md");
  const descriptionPath = join(dir, "description.txt");
  const trajectoryPath = join(dir, "trajectory.jsonl");

  const skillMd = existsSync(skillMdPath)
    ? await readFile(skillMdPath, "utf8")
    : "";

  let description = "";
  if (existsSync(descriptionPath)) {
    description = await readFile(descriptionPath, "utf8");
  } else {
    const fromYaml = extractFrontmatterDescription(skillMd);
    if (fromYaml !== null) description = fromYaml;
  }

  const trajectory: TrajectoryEntry[] = [];
  if (existsSync(trajectoryPath)) {
    const raw = await readFile(trajectoryPath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        trajectory.push(JSON.parse(line) as TrajectoryEntry);
      } catch {
        // Robustness: skip malformed lines so a single bad write does not
        // poison the entire log.
      }
    }
  }

  return { skillMd, description, trajectory };
}

export async function writeSkill(
  input: { name: string; description: string; skillMd: string },
  cwd: string = process.cwd(),
): Promise<void> {
  await publishSkill(input, cwd, false);
}

/** Capture and approval share SQLite's writer lock across processes. */
export function writeCandidateSkill(
  input: { name: string; description: string; skillMd: string },
  cwd: string = process.cwd(),
): Promise<boolean> {
  return publishSkill(input, cwd, true);
}

function contentHash(skillMd: string, description: string): string {
  const body = Buffer.from(skillMd, "utf8");
  // Length-frame the actual UTF-8 file bytes to avoid ambiguous boundaries.
  return createHash("sha256")
    .update(`${body.length}:`).update(body).update(description).digest("hex");
}

export function isApprovedPublication(
  db: Database,
  name: string,
  skillMd: string,
  description: string,
): boolean {
  const publication = db.query<{ approved_hash: string | null }, [string]>(
    "SELECT approved_hash FROM skill_publications WHERE name = ?",
  ).get(name);
  // Preserve existing unmanaged skills. Their first managed edit ends this
  // compatibility exception and requires an explicit approval of those bytes.
  return !publication || publication.approved_hash === contentHash(skillMd, description);
}

async function publishSkill(
  input: { name: string; description: string; skillMd: string },
  cwd: string,
  candidateOnly: boolean,
): Promise<boolean> {
  const validation = validateSkillManifest({
    name: input.name,
    description: input.description,
    body: input.skillMd,
  });
  if (!validation.ok) {
    throw new Error(
      `skill validation failed: ${validation.errors.join("; ")}`,
    );
  }

  const dir = skillDir(cwd, input.name);
  const db = await getSharedDb(cwd);
  // Commit an old-content pin before any filesystem mutation. WAL readers can
  // otherwise see changed files while the first metadata INSERT is uncommitted;
  // a later SQL failure must not restore the legacy compatibility exception.
  const eligible = db.transaction(() => {
    const existing = getSkill(db, input.name);
    if (candidateOnly && existing && existing.status !== "candidate") return false;
    const publication = db.query<{ name: string }, [string]>(
      "SELECT name FROM skill_publications WHERE name = ?",
    ).get(input.name);
    if (!publication) {
      let previousHash: string | null = null;
      try {
        previousHash = contentHash(
          readFileSync(join(dir, "SKILL.md"), "utf8"),
          readFileSync(join(dir, "description.txt"), "utf8"),
        );
      } catch {
        // Missing/unreadable old files cannot establish a complete publication.
      }
      db.prepare(
        "INSERT INTO skill_publications (name, content_hash, approved_hash) VALUES (?, ?, ?)",
      ).run(input.name, previousHash, existing?.status === "active" ? previousHash : null);
    }
    return true;
  }).immediate();
  if (!eligible) return false;
  // Overwrite-safe FTS sync: drop any prior row for this name, then insert
  // the fresh description. Keeps the index in lockstep with disk on every
  // write — Test 16 pins the eviction half of this contract.
  return db.transaction(() => {
    const existing = getSkill(db, input.name);
    if (candidateOnly && existing && existing.status !== "candidate") return false;
    // No await between the status check, file publication, index update and
    // registration. setStatus cannot approve a partially published candidate.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), input.skillMd, "utf8");
    writeFileSync(join(dir, "description.txt"), input.description, "utf8");
    if (!existsSync(join(dir, "trajectory.jsonl"))) {
      writeFileSync(join(dir, "trajectory.jsonl"), "", "utf8");
    }
    db.prepare(
      "INSERT INTO skill_publications (name, content_hash) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content_hash = excluded.content_hash",
    ).run(input.name, contentHash(input.skillMd, input.description));
    db.prepare("DELETE FROM skill_descriptions_fts WHERE name = ?").run(
      input.name,
    );
    db.prepare(
      "INSERT INTO skill_descriptions_fts (name, description) VALUES (?, ?)",
    ).run(input.name, input.description);
    if (candidateOnly) {
      upsertSkill(db, {
        name: input.name,
        path: `.claude/hermes/skills/${input.name}`,
        status: "candidate",
      });
    }
    return true;
  }).immediate();
}

export async function appendTrajectory(
  name: string,
  entry: Omit<TrajectoryEntry, "ts"> & { ts?: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const dir = skillDir(cwd, name);
  if (!existsSync(dir)) {
    throw new Error(
      `cannot append trajectory: skill "${name}" has not been written (missing ${dir})`,
    );
  }
  const full: TrajectoryEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    tool: entry.tool,
    ok: entry.ok,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
  await appendFile(join(dir, "trajectory.jsonl"), JSON.stringify(full) + "\n", "utf8");
}

export function searchSkills(
  db: Database,
  query: string,
  opts: { limit?: number } = {},
): Array<{ name: string; description: string; rank: number }> {
  const limit = opts.limit ?? 20;
  return db
    .query<
      { name: string; description: string; rank: number },
      [string, number]
    >(
      "SELECT name, description, rank FROM skill_descriptions_fts WHERE skill_descriptions_fts MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(query, limit);
}
