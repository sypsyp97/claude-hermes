/**
 * Translates a Discord gateway MESSAGE_CREATE event into a transport-neutral
 * Envelope. Adapter-specific glue (mentions, reply refs, DM detection) lives
 * here so the router layer downstream can stay source-agnostic.
 */

import type { Envelope, Trigger } from "../../router/envelope";

export interface DiscordAuthor {
  id: string;
  username?: string;
  global_name?: string;
  bot?: boolean;
}

export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordAuthor;
  content: string;
  referenced_message?: { id: string; author?: DiscordAuthor } | null;
  mentions?: DiscordAuthor[];
  thread?: { id: string } | null;
  attachments?: Array<{ filename?: string; content_type?: string; url: string; size?: number }>;
}

export interface DiscordContext {
  botUserId: string;
  adminIds: string[];
  workspace: string;
  channelIsThread: boolean;
  channelName?: string;
  isDm: boolean;
  channelMode?: "listen" | "mention" | "free-response";
}

export function toEnvelope(event: DiscordMessageEvent, ctx: DiscordContext): Envelope {
  const mentionedBot = event.mentions?.some((m) => m.id === ctx.botUserId) ?? false;
  const replyToBot = event.referenced_message?.author?.id === ctx.botUserId;

  const trigger: Trigger = pickTrigger({
    isDm: ctx.isDm,
    mentionedBot,
    replyToBot,
    channelMode: ctx.channelMode,
  });

  return {
    source: "discord",
    workspace: ctx.workspace,
    guild: event.guild_id,
    channel: event.channel_id,
    thread: ctx.channelIsThread ? event.channel_id : event.thread?.id,
    user: {
      id: event.author.id,
      displayName: event.author.global_name ?? event.author.username,
      isAdmin: ctx.adminIds.includes(event.author.id),
    },
    message: { text: stripMentions(event.content, ctx.botUserId) },
    attachments: (event.attachments ?? []).map((a) => ({
      kind: classifyAttachment(a.content_type),
      url: a.url,
      mimeType: a.content_type,
      bytes: a.size,
    })),
    trigger,
    receivedAt: new Date(),
  };
}

interface TriggerInput {
  isDm: boolean;
  mentionedBot: boolean;
  replyToBot: boolean;
  channelMode?: "listen" | "mention" | "free-response";
}

function pickTrigger(input: TriggerInput): Trigger {
  if (input.isDm) return "dm";
  if (input.replyToBot) return "reply";
  if (input.mentionedBot) return "mention";
  if (input.channelMode === "free-response" || input.channelMode === "listen") return "listen";
  return "mention";
}

function classifyAttachment(mime?: string): "image" | "voice" | "document" | "link" {
  if (!mime) return "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "voice";
  return "document";
}

function stripMentions(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}
