/**
 * Claude tool adapter for the FTS search. The runner exposes this via the
 * `--tool` allowlist so the agent can ask the DB for past messages without
 * reaching into the state module directly.
 */

import type { Database } from "../state/db";
import { searchSessions, type SessionSearchParams } from "../memory/search";

export const sessionSearchTool = {
  name: "session_search",
  description:
    "Full-text search across past conversation sessions. Accepts a plain-text query and optional scope/source filters.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "FTS5 query string" },
      scope: {
        type: "string",
        description: "Session scope filter (dm, per-user, per-channel-user, per-thread, shared, workspace)",
      },
      source: {
        type: "string",
        description: "Source filter (discord, telegram, web, cron, cli)",
      },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: ["query"],
  },
} as const;

export function invokeSessionSearch(db: Database, params: SessionSearchParams) {
  return searchSessions(db, params);
}
