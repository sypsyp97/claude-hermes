-- Generic key/value scratchpad for daemon state.
-- First user: dream-scheduler stores `dream.lastRunAt` so the cron can
-- self-rate-limit across daemon restarts.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
