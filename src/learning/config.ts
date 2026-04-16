/**
 * Promotion / demotion thresholds for the learned-skill pipeline.
 * Defaults are deliberately conservative so auto-promotion only fires on
 * skills with strong, repeatable signals; the dashboard surfaces them so
 * operators can tune.
 */

export interface PromotionThresholds {
  /** Minimum recorded runs within `windowDays` before promotion is even considered. */
  minRuns: number;
  /** Minimum fraction of invocations where the candidate produced a completed response. */
  minHit: number;
  /** Minimum fraction of completed runs flagged `success=true`. */
  minSuccess: number;
  /** Minimum average turns saved vs the baseline. */
  minSaved: number;
  /** Sliding window for promotion decisions (days). */
  windowDays: number;
  /** Sliding window for regression detection (days). */
  rollbackWindow: number;
  /** If success-rate drops below this inside `rollbackWindow`, demote. */
  floorSuccess: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minRuns: 20,
  minHit: 0.4,
  minSuccess: 0.85,
  minSaved: 1.0,
  windowDays: 7,
  rollbackWindow: 3,
  floorSuccess: 0.7,
};
