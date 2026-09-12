import type { Database } from "../../state/db";
import { getPolicy } from "../../state/repos/policies";
import { defaultPolicy, mergePolicy, type ChannelPolicy } from "../../policy/channel";

export function resolveTelegramPolicy(
  db: Database,
  chatId: number,
  isDm: boolean,
  topicId?: number
): ChannelPolicy {
  let policy = defaultPolicy({ source: "telegram", isDm });
  if (topicId !== undefined) policy.sessionScope = "per-thread";
  const parent = getPolicy<Partial<ChannelPolicy>>(db, { source: "telegram", channel: String(chatId) });
  if (parent) policy = mergePolicy(policy, parent);
  const topic =
    topicId === undefined
      ? null
      : getPolicy<Partial<ChannelPolicy>>(db, { source: "telegram", channel: `${chatId}:${topicId}` });
  return topic ? mergePolicy(policy, topic) : policy;
}
