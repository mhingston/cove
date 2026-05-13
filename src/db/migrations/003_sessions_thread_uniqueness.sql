CREATE UNIQUE INDEX IF NOT EXISTS sessions_agent_group_thread_idx
ON sessions(agent_group_id, thread_id)
WHERE thread_id IS NOT NULL;
