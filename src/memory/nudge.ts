/**
 * Session-end "nudge" — scan the last N turns and extract facts worth
 * keeping. The default extractor is a pure-text heuristic used by tests and
 * offline runs; production deployments plug in a Claude-CLI-backed extractor
 * via `setExtractor()`.
 */

import { appendCrossSessionMemory } from "./files";

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
}

export async function nudgeAndPersist(
  turns: TranscriptTurn[],
  opts: NudgeOptions = {}
): Promise<ExtractedFact[]> {
  const facts = await extractFacts(turns);
  for (const fact of facts) {
    const body = `- (${fact.scope}:${fact.key}) ${fact.value}`;
    await appendCrossSessionMemory(body, opts.cwd);
  }
  return facts;
}

// Simple pattern-based extractor: picks up statements like
// "my <thing> is <value>" and "remember that <x>". Good enough for unit tests
// and tiny deployments; replace via setExtractor() for real work.
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
    const rememberMatch = text.match(/^remember\s+(?:that\s+)?(.+)$/i);
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
