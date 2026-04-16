/**
 * Promoter — evaluates a single candidate or shadow skill against the
 * thresholds and applies the status transition. Every decision writes a
 * `learn_events` row so the dashboard can show an audit trail.
 *
 * The promoter is stateless across calls: callers (the cron in Phase 8)
 * schedule it, not the other way around.
 */

import type { Database } from "../state/db";
import { appendEvent } from "../state/repos/events";
import { getSkill, setStatus, upsertSkill, type SkillStatus } from "../state/repos/skills";
import { statsFor, statsSinceRunId } from "../state/repos/skillRuns";
import { DEFAULT_PROMOTION_THRESHOLDS, type PromotionThresholds } from "./config";

export type PromotionAction = "promote" | "demote" | "disable" | "noop";

export interface PromotionDecision {
  skillName: string;
  from: SkillStatus;
  to: SkillStatus;
  action: PromotionAction;
  reason: string;
  stats: {
    runs: number;
    hits: number;
    successes: number;
    avgTurnsSaved: number;
    hitRate: number;
    successRate: number;
  };
}

export function evaluatePromotion(
  db: Database,
  skillName: string,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS
): PromotionDecision {
  const row = getSkill(db, skillName);
  const from: SkillStatus = row?.status ?? "candidate";

  const stats = statsFor(db, skillName, thresholds.windowDays);
  const hitRate = stats.runs > 0 ? stats.hits / stats.runs : 0;
  const successRate = stats.hits > 0 ? stats.successes / stats.hits : 0;

  const packedStats = {
    runs: stats.runs,
    hits: stats.hits,
    successes: stats.successes,
    avgTurnsSaved: stats.avgTurnsSaved,
    hitRate,
    successRate,
  };

  if (from === "active") {
    // The rollback boundary is the row id captured at promotion time, not a
    // timestamp — sub-millisecond races would otherwise let the data that
    // justified the promotion leak into the post-promotion window.
    const sinceRunId = row?.promoted_at_run_id ?? 0;
    const recent = statsSinceRunId(db, skillName, sinceRunId);
    const recentSuccessRate = recent.hits > 0 ? recent.successes / recent.hits : 1;
    if (recent.runs >= 3 && recentSuccessRate < thresholds.floorSuccess) {
      return {
        skillName,
        from,
        to: "shadow",
        action: "demote",
        reason: `recent success-rate ${recentSuccessRate.toFixed(2)} < floor ${thresholds.floorSuccess}`,
        stats: packedStats,
      };
    }
    return {
      skillName,
      from,
      to: from,
      action: "noop",
      reason: "active skill within thresholds",
      stats: packedStats,
    };
  }

  if (stats.runs < thresholds.minRuns) {
    return {
      skillName,
      from,
      to: from,
      action: "noop",
      reason: `runs ${stats.runs} < minRuns ${thresholds.minRuns}`,
      stats: packedStats,
    };
  }
  if (hitRate < thresholds.minHit) {
    return {
      skillName,
      from,
      to: from,
      action: "noop",
      reason: `hit-rate ${hitRate.toFixed(2)} < minHit ${thresholds.minHit}`,
      stats: packedStats,
    };
  }
  if (successRate < thresholds.minSuccess) {
    return {
      skillName,
      from,
      to: from,
      action: "noop",
      reason: `success-rate ${successRate.toFixed(2)} < minSuccess ${thresholds.minSuccess}`,
      stats: packedStats,
    };
  }
  if (stats.avgTurnsSaved < thresholds.minSaved) {
    return {
      skillName,
      from,
      to: from,
      action: "noop",
      reason: `turns-saved ${stats.avgTurnsSaved.toFixed(2)} < minSaved ${thresholds.minSaved}`,
      stats: packedStats,
    };
  }

  return {
    skillName,
    from,
    to: "active",
    action: "promote",
    reason: "all thresholds met",
    stats: packedStats,
  };
}

export function applyPromotion(
  db: Database,
  skillName: string,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS
): PromotionDecision {
  const decision = evaluatePromotion(db, skillName, thresholds);
  if (decision.action === "noop") return decision;

  const row = getSkill(db, skillName);
  if (!row) upsertSkill(db, { name: skillName, path: "", status: "candidate" });
  setStatus(db, skillName, decision.to);
  appendEvent(db, `skill.${decision.action}`, decision);
  return decision;
}
