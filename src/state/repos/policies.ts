/**
 * Channel policies — per (source, guild, channel) JSON policy blobs.
 * Guild is stored as empty string when absent so the composite PK stays
 * usable (NULL would break uniqueness under SQLite's matching rules).
 */

import type { Database } from "../db";

export interface PolicyRow {
  source: string;
  guild: string;
  channel: string;
  policy_json: string;
  updated_at: string;
}

export interface PolicyKey {
  source: string;
  guild?: string | null;
  channel: string;
}

function normalizeGuild(guild: string | null | undefined): string {
  return guild ?? "";
}

export function upsertPolicy(db: Database, key: PolicyKey, policy: unknown): PolicyRow {
  const now = new Date().toISOString();
  const row = {
    source: key.source,
    guild: normalizeGuild(key.guild),
    channel: key.channel,
    policy_json: JSON.stringify(policy),
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO channel_policies (source, guild, channel, policy_json, updated_at)
     VALUES ($source, $guild, $channel, $policy_json, $updated_at)
     ON CONFLICT(source, guild, channel) DO UPDATE SET
       policy_json = excluded.policy_json,
       updated_at = excluded.updated_at`
  ).run({
    $source: row.source,
    $guild: row.guild,
    $channel: row.channel,
    $policy_json: row.policy_json,
    $updated_at: row.updated_at,
  });
  return row;
}

export function getPolicy<T = unknown>(db: Database, key: PolicyKey): T | null {
  const row = db
    .query<{ policy_json: string }, [string, string, string]>(
      "SELECT policy_json FROM channel_policies WHERE source = ? AND guild = ? AND channel = ?"
    )
    .get(key.source, normalizeGuild(key.guild), key.channel);
  if (!row) return null;
  return JSON.parse(row.policy_json) as T;
}

export function listPolicies(db: Database, source?: string): PolicyRow[] {
  if (source) {
    return db
      .query<PolicyRow, [string]>("SELECT * FROM channel_policies WHERE source = ? ORDER BY updated_at DESC")
      .all(source);
  }
  return db.query<PolicyRow, []>("SELECT * FROM channel_policies ORDER BY updated_at DESC").all();
}

export function deletePolicy(db: Database, key: PolicyKey): boolean {
  const result = db
    .prepare("DELETE FROM channel_policies WHERE source = ? AND guild = ? AND channel = ?")
    .run(key.source, normalizeGuild(key.guild), key.channel);
  return result.changes > 0;
}
