/**
 * Detector — scans the event log for repeated patterns that look like
 * candidate skills. The Phase 0 heuristic is simple: if a (skill_name,
 * success) tuple appears N times in a rolling window AND the skill is not
 * yet promoted, surface it as a candidate.
 *
 * Smarter pattern detection (multi-tool sequences, cross-session repeats)
 * plugs in via the same `detect()` contract.
 */

import type { Database } from "../state/db";
import { listEvents } from "../state/repos/events";
import { getSkill } from "../state/repos/skills";

export interface CandidateSpec {
  skillName: string;
  seenCount: number;
  firstSeen: string;
  lastSeen: string;
  suggestedStatus: "shadow";
}

export interface DetectInput {
  sinceHours?: number;
  minObservations?: number;
}

export function detectCandidates(db: Database, input: DetectInput = {}): CandidateSpec[] {
  const sinceHours = input.sinceHours ?? 24;
  const minObservations = input.minObservations ?? 3;
  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();

  const events = listEvents<{ skillName: string; success?: boolean }>(db, {
    kindPrefix: "skill.shadow.finish",
    since,
    limit: 1000,
  });

  const buckets = new Map<string, CandidateSpec>();
  for (const event of events) {
    if (!event.payload.skillName) continue;
    if (event.payload.success === false) continue;
    const current = buckets.get(event.payload.skillName);
    if (current) {
      current.seenCount++;
      if (event.ts < current.firstSeen) current.firstSeen = event.ts;
      if (event.ts > current.lastSeen) current.lastSeen = event.ts;
    } else {
      buckets.set(event.payload.skillName, {
        skillName: event.payload.skillName,
        seenCount: 1,
        firstSeen: event.ts,
        lastSeen: event.ts,
        suggestedStatus: "shadow",
      });
    }
  }

  return [...buckets.values()].filter((bucket) => {
    if (bucket.seenCount < minObservations) return false;
    const existing = getSkill(db, bucket.skillName);
    return !existing || existing.status === "candidate";
  });
}
