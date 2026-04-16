/**
 * Envelope — the unified input shape every source adapter emits.
 *
 * Discord / Telegram / Web / cron each translate their raw event into one of
 * these, and every downstream component (router, runner, memory, skills)
 * reads from this single surface. Adapter-specific fields live inside
 * `source` or `attachments`; the envelope itself is transport-agnostic.
 */

export type Source = "discord" | "telegram" | "web" | "cron" | "cli";

export type Trigger = "mention" | "reply" | "dm" | "listen" | "command" | "cron" | "heartbeat" | "voice";

export interface Attachment {
  kind: "image" | "voice" | "document" | "link";
  path?: string;
  url?: string;
  mimeType?: string;
  bytes?: number;
  transcription?: string;
}

export interface EnvelopeUser {
  id: string;
  displayName?: string;
  isAdmin: boolean;
}

export interface EnvelopeMessage {
  text: string;
  isCommand?: boolean;
  command?: string;
}

export interface Envelope {
  source: Source;
  workspace: string;
  guild?: string;
  channel?: string;
  thread?: string;
  user: EnvelopeUser;
  message: EnvelopeMessage;
  attachments: Attachment[];
  trigger: Trigger;
  receivedAt: Date;
}

export type SessionScope = "dm" | "per-user" | "per-channel-user" | "per-thread" | "shared" | "workspace";

export interface RouteDecision {
  sessionKey: string;
  sessionScope: SessionScope;
  systemPromptLayers: string[];
  allowedTools: string[];
  model?: string;
  fallbackModel?: string;
  claudeBin?: string;
}
