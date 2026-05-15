import type { Database } from 'bun:sqlite';
import type { ScheduleRecord } from '../jobs/schedules.ts';
import type { WorkflowService } from '../workflows/bridge.ts';

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

export type ChatRoutingBody = {
  agent_group_id?: string;
  model?: string;
  thread_id?: string;
};

export type ChatMessage = {
  role: SessionMessageRole;
  content: string;
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

export type SessionConfig = {
  provider: string;
  model: string;
  thinking_level?: string | null;
  api_key?: string | null;
  workspace?: string | null;
  extra_env?: Record<string, string> | null;
  permissions?: string | null;
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
  acquire(): Promise<{ sessionId: string; containerName: string; sessionDir: string } | null>;
  consume(sessionId: string): void;
  release(sessionId: string): void;
  getStats(): { ready: number; allocated: number; starting: number };
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

export type ChatHandlerContext = {
  routeRequest?(options: {
    db: Database;
    request: Request;
    body: ChatRoutingBody;
    stateDir?: string;
  }): RoutedRequest;
  pollForResponse?(options: {
    db: Database;
    sessionId: string;
    baselineOutSeq: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<OutboundMessageRow[]>;
  ensureSessionRuntime?(options: {
    routed: RoutedRequest;
    config: SessionConfig;
  }): boolean | Promise<boolean>;
  streamTokens?(options: {
    routed: RoutedRequest;
    config: SessionConfig;
    messages: ChatMessage[];
  }): AsyncGenerator<string, void, undefined>;
};

export type ScheduleRunAgentPrompt = (options: {
  schedule: {
    id: string;
    agent_group_id: string;
    prompt: string;
    mode?: string;
  };
}) => Promise<{
  content: string;
  sessionId: string;
  threadId: string;
  lastRunAt: string;
}>;

export type ScheduleStartWorkflow = (options: {
  schedule: ScheduleRecord;
  input: Record<string, unknown> | null;
}) => Promise<{
  instanceId: string;
}>;

export type ScheduleRollbackWorkflow = (options: {
  instanceId: string;
}) => Promise<void>;

export type AppContext = {
  db: Database;
  chat?: ChatHandlerContext;
  runAgentPrompt?: ScheduleRunAgentPrompt;
  startWorkflow?: ScheduleStartWorkflow;
  rollbackWorkflow?: ScheduleRollbackWorkflow;
  workflowService?: WorkflowService;
};
