/**
 * Channel policy — the declarative replacement for the old `listenChannels`
 * list plus the hire/fire LLM classifier.
 *
 * Every source+guild+channel triple resolves to one of these; the router
 * reads the policy to decide session scope, memory layer, allowed skills,
 * and model. Defaults live here so a totally un-configured daemon still
 * behaves sensibly.
 */

import type { Source } from "../router/envelope";

export type ChannelMode = "listen" | "mention" | "free-response" | "delivery-only" | "shared";

export type ChannelSessionScope = "per-user" | "per-channel-user" | "per-thread" | "shared";

export type MemoryScope = "user" | "channel" | "workspace" | "none";

export interface ChannelPolicy {
  mode: ChannelMode;
  sessionScope: ChannelSessionScope;
  autoThread: boolean;
  memoryScope: MemoryScope;
  allowedSkills: string[] | "*";
  modelPolicy?: { model?: string; fallback?: string };
  deliveryRole: "interactive" | "delivery";
}

export interface PolicyLookup {
  source: Source;
  guild?: string;
  channel?: string;
  isDm?: boolean;
}

const DM_DEFAULT: ChannelPolicy = {
  mode: "mention",
  sessionScope: "per-user",
  autoThread: false,
  memoryScope: "user",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const SERVER_DEFAULT: ChannelPolicy = {
  mode: "mention",
  sessionScope: "per-channel-user",
  autoThread: false,
  memoryScope: "channel",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const LISTEN_DEFAULT: ChannelPolicy = {
  mode: "free-response",
  sessionScope: "per-channel-user",
  autoThread: false,
  memoryScope: "channel",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const DELIVERY_DEFAULT: ChannelPolicy = {
  mode: "delivery-only",
  sessionScope: "shared",
  autoThread: false,
  memoryScope: "none",
  allowedSkills: [],
  deliveryRole: "delivery",
};

export function defaultPolicy(lookup: PolicyLookup): ChannelPolicy {
  if (lookup.isDm) return { ...DM_DEFAULT };
  return { ...SERVER_DEFAULT };
}

export function listenPolicy(): ChannelPolicy {
  return { ...LISTEN_DEFAULT };
}

export function deliveryPolicy(): ChannelPolicy {
  return { ...DELIVERY_DEFAULT };
}

export function mergePolicy(base: ChannelPolicy, override: Partial<ChannelPolicy>): ChannelPolicy {
  return { ...base, ...override };
}
