/**
 * Discord-specific channel policy resolver. Reads from the SQLite-backed
 * `channel_policies` table (Phase 2) and falls back to sensible defaults
 * when nothing is configured. The hire/fire LLM classifier is gone — the
 * DB is the source of truth.
 */

import type { Database } from "../../state/db";
import { getPolicy } from "../../state/repos/policies";
import {
  type ChannelPolicy,
  defaultPolicy,
  deliveryPolicy,
  listenPolicy,
  mergePolicy,
} from "../../policy/channel";

export interface DiscordChannelHints {
  guild?: string;
  channel?: string;
  channelName?: string;
  isDm?: boolean;
  isThread?: boolean;
  parentChannel?: string;
  parentChannelName?: string;
  legacyListen?: boolean;
}

export function resolveDiscordPolicy(db: Database, hints: DiscordChannelHints): ChannelPolicy {
  const override = hints.channel
    ? getPolicy<Partial<ChannelPolicy>>(db, {
        source: "discord",
        guild: hints.guild ?? "",
        channel: hints.channel,
      })
    : null;

  const name = (hints.isThread ? hints.parentChannelName : hints.channelName)?.toLowerCase() ?? "";
  let base: ChannelPolicy;
  if (hints.isDm) {
    base = defaultPolicy({ source: "discord", isDm: true });
  } else if (name.startsWith("ask-") || name.startsWith("listen-") || name === "listen") {
    base = listenPolicy();
  } else if (name.startsWith("deliver-") || name === "delivery") {
    base = deliveryPolicy();
  } else if (hints.legacyListen) {
    base = listenPolicy();
  } else {
    base = defaultPolicy({ source: "discord", guild: hints.guild, channel: hints.channel });
  }

  if (hints.isThread) base.sessionScope = "per-thread";
  const parent = hints.parentChannel
    ? getPolicy<Partial<ChannelPolicy>>(db, {
        source: "discord",
        guild: hints.guild,
        channel: hints.parentChannel,
      })
    : null;
  if (parent) base = mergePolicy(base, parent);
  return override ? mergePolicy(base, override) : base;
}
