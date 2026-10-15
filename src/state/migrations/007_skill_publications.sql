-- Managed publications may exist before a skill is registered. Approval pins
-- the bytes of both executable instructions and their discovery description.
CREATE TABLE IF NOT EXISTS skill_publications (
  name TEXT PRIMARY KEY,
  content_hash TEXT,
  approved_hash TEXT
);
