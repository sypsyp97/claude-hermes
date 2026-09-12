import type { ChannelPolicy } from "../policy/channel";
import type { SessionTarget } from "../runtime/session-target";
import type { Envelope } from "./envelope";
import { sessionKeyFor } from "./session-key";

interface BridgeIdentity {
  workspace: string;
  channelId: string;
  guildId?: string;
  userId: string;
  isThread?: boolean;
}

export function discordSessionTarget(input: BridgeIdentity, policy: ChannelPolicy): SessionTarget {
  const envelope: Envelope = {
    source: "discord",
    workspace: input.workspace,
    guild: input.guildId,
    channel: input.channelId,
    thread: input.isThread ? input.channelId : undefined,
    user: { id: input.userId, isAdmin: false },
    message: { text: "" },
    attachments: [],
    trigger: input.guildId ? "mention" : "dm",
    receivedAt: new Date(0),
  };
  // An explicit per-thread policy on a normal channel uses that channel's lane.
  if (policy.sessionScope === "per-thread") envelope.thread = input.channelId;
  return {
    key: sessionKeyFor({ envelope, scope: policy.sessionScope }),
    scope: policy.sessionScope,
    source: "discord",
    workspace: input.workspace,
    guild: input.guildId,
    channel: input.channelId,
    thread: envelope.thread,
    user: input.userId,
    memoryScope: policy.memoryScope,
  };
}

export function telegramSessionTarget(input: {
  workspace: string;
  chatId: number;
  userId: number;
  topicId?: number;
  isDm: boolean;
}): SessionTarget {
  const channel = String(input.chatId);
  const thread = input.topicId === undefined ? undefined : `${channel}:${input.topicId}`;
  const scope = thread ? "per-thread" : input.isDm ? "per-user" : "per-channel-user";
  const envelope: Envelope = {
    source: "telegram",
    workspace: input.workspace,
    channel,
    thread,
    user: { id: String(input.userId), isAdmin: false },
    message: { text: "" },
    attachments: [],
    trigger: input.isDm ? "dm" : "mention",
    receivedAt: new Date(0),
  };
  return {
    key: sessionKeyFor({ envelope, scope }),
    scope,
    source: "telegram",
    workspace: input.workspace,
    channel,
    thread,
    user: envelope.user.id,
    memoryScope: input.isDm ? "user" : "channel",
  };
}
