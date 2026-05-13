ALTER TABLE approvals RENAME TO approvals_old;

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
  datetime(requested_at, '+5 minutes')
FROM approvals_old;

DROP TRIGGER IF EXISTS approvals_set_expires_at_after_insert;

DROP TABLE approvals_old;
