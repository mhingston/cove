ALTER TABLE sessions RENAME TO sessions_old;
ALTER TABLE schedules RENAME TO schedules_old;
DROP TRIGGER IF EXISTS approvals_set_expires_at_after_insert;
ALTER TABLE approvals RENAME TO approvals_old;
ALTER TABLE agent_groups RENAME TO agent_groups_old;

CREATE TABLE agent_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  workspace   TEXT,
  provider    TEXT NOT NULL DEFAULT 'auto',
  model       TEXT,
  thinking    TEXT NOT NULL DEFAULT 'medium',
  permissions TEXT NOT NULL DEFAULT '{"default":"auto"}',
  soul        TEXT,
  config      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  thread_id      TEXT,
  session_file   TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id)
);

CREATE TABLE schedules (
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

CREATE TABLE approvals (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tool_args      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  requested_at   TEXT NOT NULL,
  responded_at   TEXT,
  expires_at     TEXT NOT NULL DEFAULT (datetime('now', '+5 minutes')),
  FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

INSERT INTO agent_groups (
  id,
  name,
  description,
  workspace,
  provider,
  model,
  thinking,
  permissions,
  soul,
  config,
  created_at,
  updated_at
)
SELECT
  id,
  name,
  description,
  workspace,
  CASE
    WHEN provider IS NULL OR provider = '' OR provider = 'openai' THEN 'auto'
    ELSE provider
  END,
  model,
  COALESCE(NULLIF(thinking, ''), 'medium'),
  CASE
    WHEN permissions IS NULL OR permissions = '' OR permissions = '{}' THEN '{"default":"auto"}'
    ELSE permissions
  END,
  soul,
  config,
  created_at,
  updated_at
FROM agent_groups_old;

INSERT INTO sessions (
  id,
  agent_group_id,
  thread_id,
  session_file,
  metadata,
  created_at,
  updated_at
)
SELECT
  id,
  agent_group_id,
  thread_id,
  session_file,
  metadata,
  created_at,
  updated_at
FROM sessions_old;

INSERT INTO schedules (
  id,
  agent_group_id,
  cron_expr,
  prompt,
  mode,
  enabled,
  last_run_at,
  next_run_at,
  created_at
)
SELECT
  id,
  agent_group_id,
  cron_expr,
  prompt,
  mode,
  enabled,
  last_run_at,
  next_run_at,
  created_at
FROM schedules_old;

INSERT INTO approvals (
  id,
  agent_group_id,
  session_id,
  tool_name,
  tool_args,
  status,
  requested_at,
  responded_at,
  expires_at
)
SELECT
  id,
  agent_group_id,
  session_id,
  tool_name,
  tool_args,
  status,
  requested_at,
  responded_at,
  COALESCE(expires_at, datetime(requested_at, '+5 minutes'))
FROM approvals_old;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_agent_group_thread_idx
ON sessions(agent_group_id, thread_id)
WHERE thread_id IS NOT NULL;

DROP TRIGGER IF EXISTS approvals_set_expires_at_after_insert;

DROP TABLE approvals_old;
DROP TABLE schedules_old;
DROP TABLE sessions_old;

DROP TABLE agent_groups_old;
