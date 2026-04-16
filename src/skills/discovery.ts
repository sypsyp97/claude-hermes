/**
 * Pure filesystem discovery of SKILL.md manifests across project, user, and
 * plugin trees. No network, no mutation — just `readdir` + `readFile`.
 *
 * Phase 6's learning pipeline reads the returned `path` + `source` fields to
 * classify candidate skills and track promotion state, so the shape must stay
 * stable across phases.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillSource = "project" | "global" | "plugin";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  plugin?: string;
}

export interface DiscoveryRoots {
  cwd?: string;
  home?: string;
}

export async function discoverSkills(roots: DiscoveryRoots = {}): Promise<SkillInfo[]> {
  const cwd = roots.cwd ?? process.cwd();
  const home = roots.home ?? homedir();
  const projectSkillsDir = join(cwd, ".claude", "skills");
  const globalSkillsDir = join(home, ".claude", "skills");
  const pluginsDir = join(home, ".claude", "plugins");

  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  await collectFromDir(projectSkillsDir, "project", null, seen, skills);
  await collectFromDir(globalSkillsDir, "global", null, seen, skills);

  const cachePath = join(pluginsDir, "cache");
  if (existsSync(cachePath)) {
    try {
      const pluginDirs = await readdir(cachePath, { withFileTypes: true });
      for (const pd of pluginDirs) {
        if (!pd.isDirectory()) continue;
        const pluginCacheDir = join(cachePath, pd.name);
        const subDirs = await readdir(pluginCacheDir, { withFileTypes: true }).catch(() => []);
        for (const sub of subDirs) {
          if (!sub.isDirectory()) continue;
          const innerDir = join(pluginCacheDir, sub.name);
          const verDirs = await readdir(innerDir, { withFileTypes: true }).catch(() => []);
          for (const ver of verDirs) {
            if (!ver.isDirectory()) continue;
            await collectFromDir(join(innerDir, ver.name, "skills"), "plugin", pd.name, seen, skills);
          }
          await collectFromDir(join(innerDir, "skills"), "plugin", pd.name, seen, skills);
        }
      }
    } catch {
      // cache dir not readable
    }
  }

  return skills;
}

async function collectFromDir(
  dir: string,
  source: SkillSource,
  plugin: string | null,
  seen: Set<string>,
  out: SkillInfo[],
): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      let content: string;
      try {
        content = await readFile(skillPath, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;

      const name = plugin ? `${plugin}_${entry.name}` : entry.name;
      if (seen.has(name)) continue;
      seen.add(name);

      const info: SkillInfo = {
        name,
        description: extractDescription(content),
        path: skillPath,
        source,
      };
      if (plugin) info.plugin = plugin;
      out.push(info);
    }
  } catch {
    // dir not readable
  }
}

export function extractDescription(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*>?\s*\n?([\s\S]*?)(?=\n\w|\n---|\n$)/m);
    if (descMatch) {
      const raw = descMatch[1].replace(/\n\s*/g, " ").trim();
      if (raw) return raw.slice(0, 256);
    }
    const singleMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (singleMatch) return singleMatch[1].trim().slice(0, 256);
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed.slice(0, 256);
  }
  return "Claude Code skill";
}
