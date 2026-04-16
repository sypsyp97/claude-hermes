-- Hermes state engine — initial schema.
-- ISO-8601 UTC timestamps are stored as TEXT (sortable, portable). JSON blobs
-- stay as TEXT; callers parse/serialise at the repo boundary.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  workspace TEXT NOT NULL,
  guild TEXT,
  channel TEXT,
  thread TEXT,
  user TEXT,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  compact_warned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls_json TEXT,
  attachments_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS channel_policies (
  source TEXT NOT NULL,
  guild TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, guild, channel)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_scope_key ON memory_entries(scope, key);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_entries(expires_at);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','shadow','active','disabled')),
  trigger_tags_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  -- Last skill_runs.id observed at promotion time. The rollback window filters
  -- runs by `id > promoted_at_run_id` instead of timestamp comparison, which
  -- avoids a race when multiple inserts land in the same millisecond bucket.
  promoted_at_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS skill_versions (
  skill_name TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_run_id INTEGER,
  skill_md TEXT,
  skill_yaml TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (skill_name, version)
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  success INTEGER,
  turns_saved REAL,
  tools_used_json TEXT,
  user_feedback TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_name_started ON skill_runs(skill_name, started_at);

CREATE TABLE IF NOT EXISTS learn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_events_ts ON learn_events(ts);
CREATE INDEX IF NOT EXISTS idx_learn_events_kind ON learn_events(kind);

CREATE TABLE IF NOT EXISTS jobs (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  schedule TEXT NOT NULL,
  recurring INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_result TEXT,
  notify INTEGER NOT NULL DEFAULT 0
);
