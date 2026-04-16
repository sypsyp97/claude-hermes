/**
 * Skills repo — registry of candidate/shadow/active/disabled skills.
 * Phase 6's learning pipeline owns writes; discovery (`src/skills/`) still
 * provides the SKILL.md parsing. Rows here hold promotion state + telemetry
 * hooks, not the manifest body.
 */

import type { Database } from "../db";

export type SkillStatus = "candidate" | "shadow" | "active" | "disabled";

export interface SkillRow {
  name: string;
  path: string;
  status: SkillStatus;
  trigger_tags_json: string;
  allowed_tools_json: string;
  created_at: string;
  promoted_at: string | null;
  promoted_at_run_id: number | null;
}

export interface NewSkill {
  name: string;
  path: string;
  status?: SkillStatus;
  triggerTags?: string[];
  allowedTools?: string[];
}

export function upsertSkill(db: Database, input: NewSkill): SkillRow {
  const now = new Date().toISOString();
  const status = input.status ?? "candidate";
  db.prepare(
    `INSERT INTO skills (name, path, status, trigger_tags_json, allowed_tools_json, created_at)
     VALUES ($name, $path, $status, $tags, $tools, $now)
     ON CONFLICT(name) DO UPDATE SET
       path = excluded.path,
       trigger_tags_json = excluded.trigger_tags_json,
       allowed_tools_json = excluded.allowed_tools_json`
  ).run({
    $name: input.name,
    $path: input.path,
    $status: status,
    $tags: JSON.stringify(input.triggerTags ?? []),
    $tools: JSON.stringify(input.allowedTools ?? []),
    $now: now,
  });
  return getSkill(db, input.name)!;
}

export function getSkill(db: Database, name: string): SkillRow | null {
  return db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(name) ?? null;
}

export function listSkills(db: Database, status?: SkillStatus): SkillRow[] {
  if (status) {
    return db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE status = ? ORDER BY name ASC")
      .all(status);
  }
  return db.query<SkillRow, []>("SELECT * FROM skills ORDER BY name ASC").all();
}

export function setStatus(
  db: Database,
  name: string,
  status: SkillStatus,
  promote = status === "active"
): void {
  if (promote) {
    const maxRunId =
      db
        .query<{ max_id: number | null }, [string]>(
          "SELECT MAX(id) AS max_id FROM skill_runs WHERE skill_name = ?"
        )
        .get(name)?.max_id ?? 0;
    db.prepare("UPDATE skills SET status = ?, promoted_at = ?, promoted_at_run_id = ? WHERE name = ?").run(
      status,
      new Date().toISOString(),
      maxRunId,
      name
    );
  } else {
    db.prepare("UPDATE skills SET status = ? WHERE name = ?").run(status, name);
  }
}

export function recordVersion(
  db: Database,
  input: {
    skillName: string;
    version: number;
    sourceRunId?: number | null;
    skillMd?: string | null;
    skillYaml?: string | null;
  }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO skill_versions
     (skill_name, version, source_run_id, skill_md, skill_yaml, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.skillName,
    input.version,
    input.sourceRunId ?? null,
    input.skillMd ?? null,
    input.skillYaml ?? null,
    new Date().toISOString()
  );
}

export function latestVersion(db: Database, skillName: string): number {
  const row = db
    .query<{ version: number }, [string]>(
      "SELECT MAX(version) AS version FROM skill_versions WHERE skill_name = ?"
    )
    .get(skillName);
  return row?.version ?? 0;
}
