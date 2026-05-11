CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- #337 (v0.9.0 Hermes parity): tokenize='trigram' replaces the default
-- unicode61 tokenizer so CJK (Chinese/Japanese/Korean) substring search
-- hits the FTS5 index instead of falling back to a LIKE scan. Existing
-- deployments are migrated by `runFts5TrigramMigration` at startup.
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  content,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);

-- #337 (v0.9.0): companion FTS5 index for the memories table. Same trigram
-- tokenizer so summary text indexed for fast CJK substring search.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  session_id UNINDEXED,
  scope UNINDEXED,
  summary,
  tokenize='trigram'
);