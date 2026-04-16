/**
 * Thin barrel that re-exports the router-facing skill surface.
 * All logic now lives under `src/skills/` (discovery vs registry split).
 */

export { discoverSkills, extractDescription } from "./skills/discovery";
export { listSkills, resolveSkillPrompt } from "./skills/registry";
export type { SkillInfo, SkillSource } from "./skills/discovery";
