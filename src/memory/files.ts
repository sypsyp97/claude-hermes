/**
 * Filesystem readers/writers for the layered markdown memory files.
 *
 * Layout:
 *   .claude/hermes/memory/
 *     SOUL.md            — long-lived agent identity (human-edited)
 *     IDENTITY.md        — workspace identity / tone
 *     USER.md            — facts about the human owner
 *     MEMORY.md          — cross-session facts (auto-appended by nudge)
 *     channels/<id>.md   — per-channel playbook
 *
 * All reads return `""` for missing files — callers treat absence as silent.
 * Writes create the containing directory as needed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  channelMemoryFile,
  crossSessionMemoryFile,
  identityMemoryFile,
  soulMemoryFile,
  userMemoryFile,
} from "../paths";

export async function readSoul(cwd?: string): Promise<string> {
  return readIfExists(soulMemoryFile(cwd));
}

export async function readIdentity(cwd?: string): Promise<string> {
  return readIfExists(identityMemoryFile(cwd));
}

export async function readUserMemory(cwd?: string): Promise<string> {
  return readIfExists(userMemoryFile(cwd));
}

export async function readCrossSessionMemory(cwd?: string): Promise<string> {
  return readIfExists(crossSessionMemoryFile(cwd));
}

export async function readChannelMemory(channelId: string, cwd?: string): Promise<string> {
  return readIfExists(channelMemoryFile(channelId, cwd));
}

export async function appendCrossSessionMemory(entry: string, cwd?: string): Promise<void> {
  const path = crossSessionMemoryFile(cwd);
  const now = new Date().toISOString();
  const payload = `\n<!-- ${now} -->\n${entry.trim()}\n`;
  await appendToFile(path, payload);
}

export async function writeUserMemory(content: string, cwd?: string): Promise<void> {
  const path = userMemoryFile(cwd);
  await writeWithMkdir(path, content.trimEnd() + "\n");
}

export async function writeChannelMemory(channelId: string, content: string, cwd?: string): Promise<void> {
  const path = channelMemoryFile(channelId, cwd);
  await writeWithMkdir(path, content.trimEnd() + "\n");
}

async function readIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function appendToFile(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const prev = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, prev + payload, "utf8");
}

async function writeWithMkdir(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
