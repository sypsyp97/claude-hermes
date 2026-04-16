/**
 * Deterministic session-key builder.
 *
 * The key collapses the envelope's identity triple (guild, channel, thread,
 * user) into a scope-specific string so two events that should share a
 * session always hash to the same key. Changing the output format is a
 * breaking change — every existing row in `sessions.key` becomes stranded.
 */

import { createHash } from "node:crypto";
import type { Envelope, SessionScope } from "./envelope";

export interface SessionKeyInput {
  envelope: Envelope;
  scope: SessionScope;
}

export function sessionKeyFor({ envelope, scope }: SessionKeyInput): string {
  switch (scope) {
    case "dm":
      return `dm:${envelope.source}:${envelope.user.id}`;
    case "per-user":
      return `user:${envelope.source}:${envelope.user.id}`;
    case "per-channel-user":
      return `channel-user:${envelope.source}:${envelope.guild ?? "_"}:${envelope.channel ?? "_"}:${envelope.user.id}`;
    case "per-thread":
      if (!envelope.thread) {
        throw new Error("sessionKeyFor: per-thread scope requires envelope.thread");
      }
      return `thread:${envelope.source}:${envelope.thread}`;
    case "shared":
      return `shared:${envelope.source}:${envelope.guild ?? "_"}:${envelope.channel ?? "_"}`;
    case "workspace":
      return `workspace:${hash(envelope.workspace)}`;
  }
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
