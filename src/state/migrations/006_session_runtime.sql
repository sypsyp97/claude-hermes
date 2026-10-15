-- Runtime ownership survives resets and exists before a conversation's first turn.
CREATE TABLE IF NOT EXISTS session_runtime (
  key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  owner_pid INTEGER,
  child_pid INTEGER
);
