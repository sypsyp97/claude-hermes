/**
 * Compose the 5-layer system prompt (SOUL → IDENTITY → USER → MEMORY → CHANNEL).
 *
 * Missing layers are silently skipped — the prompt is still well-formed,
 * just shorter. Each layer is joined by a blank line so Claude sees them as
 * distinct blocks.
 */

import type { ChannelPolicy } from "../policy/channel";
import { readChannelMemory, readCrossSessionMemory, readIdentity, readSoul, readUserMemory } from "./files";

export interface ComposeContext {
  channelId?: string;
  memoryScope: ChannelPolicy["memoryScope"];
  cwd?: string;
  /** Optional hard cap on total characters; layers are trimmed front-to-back. */
  maxBytes?: number;
}

export async function composeSystemPrompt(ctx: ComposeContext): Promise<string> {
  const layers = await readLayers(ctx);
  const joined = layers.filter((l) => l.trim().length > 0).join("\n\n");
  if (ctx.maxBytes && joined.length > ctx.maxBytes) {
    return joined.slice(0, ctx.maxBytes);
  }
  return joined;
}

async function readLayers(ctx: ComposeContext): Promise<string[]> {
  const [soul, identity] = await Promise.all([readSoul(ctx.cwd), readIdentity(ctx.cwd)]);
  const layers: string[] = [soul, identity];

  if (ctx.memoryScope === "user" || ctx.memoryScope === "workspace") {
    layers.push(await readUserMemory(ctx.cwd));
  }

  if (ctx.memoryScope !== "none") {
    layers.push(await readCrossSessionMemory(ctx.cwd));
  }

  if (ctx.channelId && (ctx.memoryScope === "channel" || ctx.memoryScope === "workspace")) {
    layers.push(await readChannelMemory(ctx.channelId, ctx.cwd));
  }

  return layers;
}
