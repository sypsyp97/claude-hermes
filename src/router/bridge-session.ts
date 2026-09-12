import { canonicalWorkspace } from "../paths";
import { defaultPolicy, type ChannelPolicy } from "../policy/channel";
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
    workspace: canonicalWorkspace(input.workspace),
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
    workspace: canonicalWorkspace(input.workspace),
    guild: input.guildId,
    channel: input.channelId,
    thread: envelope.thread,
    user: input.userId,
    memoryScope: policy.memoryScope,
    policy: { allowedSkills: policy.allowedSkills, modelPolicy: policy.modelPolicy },
  };
}

export function telegramSessionTarget(
  input: {
    workspace: string;
    chatId: number;
    userId: number;
    topicId?: number;
    isDm: boolean;
  },
  policy?: ChannelPolicy
): SessionTarget {
  const channel = String(input.chatId);
  const effective = policy ?? {
    ...defaultPolicy({ source: "telegram", isDm: input.isDm }),
    ...(input.topicId !== undefined ? { sessionScope: "per-thread" as const } : {}),
  };
  const scope = effective.sessionScope;
  const thread =
    input.topicId === undefined
      ? scope === "per-thread"
        ? channel
        : undefined
      : `${channel}:${input.topicId}`;
  const envelope: Envelope = {
    source: "telegram",
    workspace: canonicalWorkspace(input.workspace),
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
    workspace: canonicalWorkspace(input.workspace),
    channel,
    thread,
    user: envelope.user.id,
    memoryScope: effective.memoryScope,
    policy: { allowedSkills: effective.allowedSkills, modelPolicy: effective.modelPolicy },
  };
}
