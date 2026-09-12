import type { Job } from "../jobs";
import { telegramStatusTransport } from "../commands/telegram";
import { createTelegramStatusSink } from "./sinks/telegram";
/**
 * Build a StatusSink for a scheduled job (or the heartbeat), using Discord as
 * the destination when both a bot token and a status channel are configured.
 *
 * Returns undefined when either piece of configuration is missing — callers
 * treat "no sink" as "skip live status rendering" rather than an error. This
 * keeps the code path optional: jobs still run and log normally without a
 * channel to post into.
 */

import type { Settings } from "../config";
import { discordStatusTransport } from "../commands/discord";
import { createDiscordStatusSink } from "./sinks/discord";
import type { StatusSink } from "./sink";

export function createJobStatusSink(
  _label: string,
  settings: Settings,
  job?: Job,
): StatusSink | undefined {
  const token = settings.discord.token;
  const channelId = job?.notifyChannel ?? (job?.notifyTelegramChat === undefined ? settings.discord.statusChannelId : undefined);
  if (!job?.notifyChannel && job?.notifyTelegramChat !== undefined) {
    return settings.telegram.token ? createTelegramStatusSink({transport:telegramStatusTransport(settings.telegram.token),chatId:job.notifyTelegramChat,threadId:job.notifyTelegramTopic}) : undefined;
  }
  if (!token || !channelId) return undefined;
  return createDiscordStatusSink({
    transport: discordStatusTransport(token),
    channelId,
  });
}
