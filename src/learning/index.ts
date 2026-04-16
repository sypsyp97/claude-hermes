/**
 * Barrel for the learning pipeline.
 */

export {
  DEFAULT_PROMOTION_THRESHOLDS,
  type PromotionThresholds,
} from "./config";
export { startCollect, finishCollect } from "./collector";
export { detectCandidates, type CandidateSpec, type DetectInput } from "./detector";
export { compileCandidate, type CompiledSkill, type CompileOptions } from "./compiler";
export {
  applyPromotion,
  evaluatePromotion,
  type PromotionAction,
  type PromotionDecision,
} from "./promoter";
export { listActiveSkills, listCandidateSkills } from "./registry";
