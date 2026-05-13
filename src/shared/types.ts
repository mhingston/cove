import type { Database } from 'bun:sqlite';

export type AgentGroupSummaryRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentGroupRow = AgentGroupSummaryRow & {
  workspace: string | null;
  provider: string;
  model: string | null;
  thinking: string;
  permissions: string;
  soul: string | null;
  config: string | null;
};

export type AppContext = {
  db: Database;
};

export type ChatRoutingBody = {
  agent_group_id?: string;
  model?: string;
  thread_id?: string;
};

export type SessionRow = {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
  session_file: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

export type RoutedRequest = {
  agentGroup: AgentGroupRow;
  threadId: string;
  session: SessionRow;
};

export type ModelResponseItem = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'cove';
};

export type WarmPool = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type Scheduler = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type SweepHandle = {
  stop(): Promise<void>;
};

export type ApiServer = {
  hostname: string;
  port: number;
  stop(): Promise<void>;
};

export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type InboundMessageInput = {
  id: string;
  role: SessionMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
};

export type InboundMessageRow = {
  id: string;
  seq: number;
  role: SessionMessageRole;
  content: string;
  metadata: string | null;
  created_at: string;
};

export type OutboundMessageInput = {
  id: string;
  seq: number;
  role: SessionMessageRole;
  content: string;
  finish_reason?: string | null;
  tool_calls?: unknown;
  metadata?: Record<string, unknown>;
};

export type OutboundMessageRow = {
  id: string;
  seq: number;
  role: SessionMessageRole;
  content: string;
  finish_reason: string | null;
  tool_calls: string | null;
  metadata: string | null;
  created_at: string;
};

export type ProcessingAckRow = {
  session_id: string;
  last_in_seq: number | null;
  last_out_seq: number | null;
  container_id: string | null;
  heartbeat_at: string;
};

export type ProcessingAckInput = {
  session_id: string;
  last_in_seq: number | null;
  last_out_seq: number | null;
  container_id?: string | null;
  heartbeat_at: string;
};
