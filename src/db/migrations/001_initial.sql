CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  workspace   TEXT,
  provider    TEXT NOT NULL DEFAULT 'openai',
  model       TEXT,
  thinking    TEXT NOT NULL DEFAULT 'medium',
  permissions TEXT NOT NULL DEFAULT '{}',
  soul        TEXT,
  config      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  thread_id      TEXT,
  session_file   TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id)
);

CREATE TABLE IF NOT EXISTS wiki_entries (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT,
  provenance TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  title, content, tags,
  content=wiki_entries, content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  embedding      BLOB,
  agent_group_id TEXT NOT NULL,
  session_id     TEXT,
  importance     REAL NOT NULL DEFAULT 0.5,
  created_at     TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content=memories, content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS schedules (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  cron_expr      TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'agent',
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_run_at    TEXT,
  next_run_at    TEXT,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tool_args      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  requested_at   TEXT NOT NULL,
  responded_at   TEXT,
  FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
