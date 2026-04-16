/**
 * Router — composes an Envelope + environment config into a RouteDecision.
 *
 * Inputs this function cares about:
 *  - envelope (source, guild, channel, thread, user, trigger)
 *  - auth policy (allowed user IDs)
 *  - channel policy (mode, session scope, allowed skills, memory scope)
 *  - default model + fallback
 *
 * Outputs:
 *  - sessionKey (deterministic), sessionScope
 *  - systemPromptLayers (SOUL → IDENTITY → USER → MEMORY → CHANNEL)
 *  - allowedTools (intersection of global + channel + skill)
 *  - model / fallbackModel / claudeBin
 */

import type { Envelope, RouteDecision, SessionScope } from "./envelope";
import { sessionKeyFor } from "./session-key";
import { checkAuth, type AuthDecision, type AuthPolicy } from "./auth";

export interface ChannelPolicy {
  sessionScope: SessionScope;
  allowedTools: string[] | "*";
  memoryScope: "user" | "channel" | "workspace" | "none";
  model?: string;
  fallbackModel?: string;
}

export interface RouteEnv {
  auth: AuthPolicy;
  defaultModel?: string;
  defaultFallbackModel?: string;
  defaultAllowedTools: string[];
  claudeBin?: string;
  policyFor(envelope: Envelope): ChannelPolicy;
  promptLayers(envelope: Envelope, memoryScope: ChannelPolicy["memoryScope"]): string[];
}

export interface RoutedEnvelope {
  envelope: Envelope;
  auth: AuthDecision;
  policy: ChannelPolicy;
  decision: RouteDecision;
}

export function route(envelope: Envelope, env: RouteEnv): RoutedEnvelope {
  const auth = checkAuth(envelope, env.auth);
  const policy = env.policyFor(envelope);

  const sessionKey = sessionKeyFor({ envelope, scope: policy.sessionScope });
  const promptLayers = env.promptLayers(envelope, policy.memoryScope);

  const allowedTools =
    policy.allowedTools === "*"
      ? env.defaultAllowedTools
      : intersect(env.defaultAllowedTools, policy.allowedTools);

  const decision: RouteDecision = {
    sessionKey,
    sessionScope: policy.sessionScope,
    systemPromptLayers: promptLayers,
    allowedTools,
    model: policy.model ?? env.defaultModel,
    fallbackModel: policy.fallbackModel ?? env.defaultFallbackModel,
    claudeBin: env.claudeBin,
  };

  return { envelope, auth, policy, decision };
}

function intersect<T>(a: T[], b: T[]): T[] {
  const set = new Set(a);
  return b.filter((x) => set.has(x));
}
