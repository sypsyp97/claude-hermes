/**
 * Compiler — materialises a candidate as filesystem artefacts the skill
 * runner can load. Writes:
 *   .claude/hermes/skills/candidates/<name>/SKILL.md
 *   .claude/hermes/skills/candidates/<name>/skill.yaml
 *
 * The on-disk layout mirrors production skills so evaluation runs through
 * the same resolver. The yaml holds Phase 6 metadata (status, allowed
 * tools, source run ids) that is not yet encoded in SKILL.md frontmatter.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hermesDir } from "../paths";
import type { CandidateSpec } from "./detector";

export interface CompiledSkill {
  name: string;
  skillMdPath: string;
  skillYamlPath: string;
  dir: string;
}

export interface CompileOptions {
  cwd?: string;
  description?: string;
  body?: string;
  allowedTools?: string[];
  sourceRunIds?: number[];
}

export async function compileCandidate(
  spec: CandidateSpec,
  opts: CompileOptions = {}
): Promise<CompiledSkill> {
  const cwd = opts.cwd ?? process.cwd();
  const root = join(hermesDir(cwd), "skills", "candidates", spec.skillName);
  await mkdir(root, { recursive: true });

  const description = opts.description ?? `Auto-detected candidate from ${spec.seenCount} shadow run(s).`;
  const body =
    opts.body ??
    [
      `This is an auto-compiled candidate skill for \`${spec.skillName}\`.`,
      `It was surfaced by the learning pipeline after ${spec.seenCount} successful shadow runs`,
      `between ${spec.firstSeen} and ${spec.lastSeen}.`,
    ].join(" ");
  const skillMd = [
    "---",
    `name: ${spec.skillName}`,
    `description: ${description}`,
    "status: candidate",
    "---",
    "",
    body,
    "",
  ].join("\n");

  const yaml = [
    `name: ${spec.skillName}`,
    "status: candidate",
    `first_seen: ${spec.firstSeen}`,
    `last_seen: ${spec.lastSeen}`,
    `shadow_runs: ${spec.seenCount}`,
    `allowed_tools: [${(opts.allowedTools ?? []).map((t) => JSON.stringify(t)).join(", ")}]`,
    `source_run_ids: [${(opts.sourceRunIds ?? []).join(", ")}]`,
    "",
  ].join("\n");

  const skillMdPath = join(root, "SKILL.md");
  const skillYamlPath = join(root, "skill.yaml");
  await writeFile(skillMdPath, skillMd, "utf8");
  await writeFile(skillYamlPath, yaml, "utf8");

  return { name: spec.skillName, skillMdPath, skillYamlPath, dir: root };
}
