/**
 * Cross-session search: a thin wrapper around `messagesRepo.search` that
 * returns a user-friendly shape. Exposed both as a Claude tool
 * (`src/tools/session-search.ts`) and via the dashboard.
 */

import type { Database } from "../state/db";
import { search, type SearchHit } from "../state/repos/messages";

export interface SessionSearchParams {
  query: string;
  scope?: string;
  source?: string;
  limit?: number;
}

export function searchSessions(db: Database, params: SessionSearchParams): SearchHit[] {
  if (!params.query.trim()) return [];
  return search(db, params.query, {
    scope: params.scope,
    source: params.source,
    limit: params.limit,
  });
}
