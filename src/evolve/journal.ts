/**
 * Journal — the human-readable side of the evolve loop. Writes a daily
 * markdown journal under `.claude/hermes/memory/journal/<date>.md` and
 * appends structured `evolve.*` events into `learn_events` for machine
 * consumption.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { memoryDir } from "../paths";
import type { Database } from "../state/db";
import { appendEvent } from "../state/repos/events";

export type EvolveEventKind =
  | "evolve.plan"
  | "evolve.exec.start"
  | "evolve.exec.done"
  | "evolve.commit"
  | "evolve.revert"
  | "evolve.skip";

export interface EvolveEvent {
  kind: EvolveEventKind;
  slot: string;
  summary: string;
  details?: unknown;
}

export async function recordEvent(db: Database, event: EvolveEvent, cwd?: string): Promise<void> {
  appendEvent(db, event.kind, { slot: event.slot, summary: event.summary, details: event.details });
  await appendDailyJournal(event, cwd);
}

export function journalFile(date: Date, cwd?: string): string {
  const iso = date.toISOString().slice(0, 10);
  return join(memoryDir(cwd), "journal", `${iso}.md`);
}

async function appendDailyJournal(event: EvolveEvent, cwd?: string): Promise<void> {
  const path = journalFile(new Date(), cwd);
  await mkdir(dirname(path), { recursive: true });
  const header = existsSync(path) ? "" : `# Evolve journal — ${new Date().toISOString().slice(0, 10)}\n\n`;
  const prev = existsSync(path) ? await readFile(path, "utf8") : "";
  const entry = [
    `## ${new Date().toISOString()} — ${event.kind} — ${event.slot}`,
    "",
    event.summary,
    "",
  ].join("\n");
  await writeFile(path, prev + header + entry + "\n", "utf8");
}
