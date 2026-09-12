/**
 * Session-end "nudge" — scan the last N turns and extract facts worth
 * keeping. The default extractor is a pure-text heuristic used by tests and
 * offline runs. Only explicit statements from human turns are remembered;
 * generated replies, skill instructions and tool results are never extracted.
 */

import { appendCrossSessionMemory } from "./files";
import { createHash } from "node:crypto";
import { getSharedDb } from "../state/shared-db";
import { insertMemory } from "../state/repos/memory";
import type { MemoryScope } from "../policy/channel";

export interface TranscriptTurn {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

export interface ExtractedFact {
  scope: "user" | "channel" | "workspace";
  key: string;
  value: string;
}

export type Extractor = (turns: TranscriptTurn[]) => Promise<ExtractedFact[]>;

let activeExtractor: Extractor = heuristicExtractor;

export function setExtractor(fn: Extractor): void {
  activeExtractor = fn;
}

export function resetExtractor(): void {
  activeExtractor = heuristicExtractor;
}

export async function extractFacts(turns: TranscriptTurn[]): Promise<ExtractedFact[]> {
  return activeExtractor(turns);
}

export interface NudgeOptions {
  cwd?: string;
  channelId?: string;
  sourceSessionId?: number;
  memoryScope?: MemoryScope;
}

export async function nudgeAndPersist(
  turns: TranscriptTurn[],
  opts: NudgeOptions = {}
): Promise<ExtractedFact[]> {
  if (opts.memoryScope === "none") return [];
  const facts = (await extractFacts(turns))
    .filter((fact) => fact.key.trim() && fact.value.trim())
    .slice(0, 8)
    .map((fact) => ({ ...fact, key: fact.key.slice(0, 80), value: fact.value.slice(0, 2000) }));
  if (opts.sourceSessionId !== undefined) {
    const db = await getSharedDb(opts.cwd);
    db.transaction(() => {
      for (const fact of facts) {
        // Free-form notes are independent; named fields retain replacement semantics.
        const key =
          fact.key === "note"
            ? `note:${createHash("sha256").update(fact.value).digest("hex").slice(0, 16)}`
            : fact.key;
        const latest = db
          .query<{ value: string }, [number, string, string]>(
            "SELECT value FROM memory_entries WHERE source_session_id = ? AND scope = ? AND key = ? ORDER BY id DESC LIMIT 1"
          )
          .get(opts.sourceSessionId!, fact.scope, key);
        if (latest?.value !== fact.value)
          insertMemory(db, { ...fact, key, sourceSessionId: opts.sourceSessionId });
      }
    })();
    return facts;
  }
  for (const fact of facts) {
    const body = `- (${fact.scope}:${fact.key}) ${fact.value}`;
    await appendCrossSessionMemory(body, opts.cwd);
  }
  return facts;
}

// Simple pattern-based extractor: picks up statements like
// "my <thing> is <value>" and "remember that <x>". Good enough for unit tests
// and explicit fact capture without an extra model request.
async function heuristicExtractor(turns: TranscriptTurn[]): Promise<ExtractedFact[]> {
  const facts: ExtractedFact[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const text = turn.content.trim();
    const myMatch = text.match(/^my\s+([a-z][\w\s-]{0,40})\s+is\s+(.+)$/i);
    if (myMatch) {
      facts.push({
        scope: "user",
        key: myMatch[1].trim().toLowerCase(),
        value: myMatch[2].trim(),
      });
      continue;
    }
    const rememberMatch = text.match(/^(?:remember\s+(?:that\s+)?|(?:请)?记住[：:\s]*)(.+)$/i);
    if (rememberMatch) {
      facts.push({
        scope: "workspace",
        key: "note",
        value: rememberMatch[1].trim(),
      });
    }
  }
  return facts;
}
