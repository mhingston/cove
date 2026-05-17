import type { Database } from 'bun:sqlite';
import { Database as SqliteDatabase } from 'bun:sqlite';

import {
  storeMemoryWithEmbedding,
  type EmbedTexts,
} from '../context/external.ts';
import {
  createWikiEntry,
  getWikiEntry,
  hybridSearchWikiEntries,
} from '../knowledge/wiki.ts';
import { hybridSearch } from '../knowledge/search.ts';
import { createWorkflowBridge } from './workflow-bridge.ts';

export type ToolResultPart = {
  type: 'text';
  text: string;
};

export type ToolResult = {
  content: ToolResultPart[];
  details: Record<string, unknown>;
};

export type ToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ): Promise<ToolResult>;
};

export type CoveToolRuntimeOptions = {
  agentGroupId?: string;
  centralDbPath?: string;
  sessionId?: string;
  workflowApiBaseUrl?: string;
};

function jsonToolResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: {},
  };
}

function workflowToolErrorResult(name: string, error: unknown): ToolResult {
  return jsonToolResult({
    tool: name,
    error: error instanceof Error ? error.message : String(error),
  });
}

function resolveAgentGroupId(value: unknown, fallback?: string): string | undefined {
  const direct = typeof value === 'string' ? value.trim() : '';

  if (direct) {
    return direct;
  }

  const runtime = fallback?.trim();
  return runtime ? runtime : undefined;
}

function resolveCentralDbPath(runtime?: CoveToolRuntimeOptions): string | undefined {
  return runtime?.centralDbPath ?? process.env.COVE_CENTRAL_DB_PATH;
}

function openCentralDb(runtime?: CoveToolRuntimeOptions): Database | null {
  const dbPath = resolveCentralDbPath(runtime);

  if (!dbPath) {
    return null;
  }

  try {
    return new SqliteDatabase(dbPath);
  } catch {
    return null;
  }
}

function createSearchMemoriesTool(
  db: Database,
  name: string,
  label: string,
  embedTexts?: EmbedTexts,
  runtime?: CoveToolRuntimeOptions,
): ToolDefinition {
  return {
    name,
    label,
    description: 'Search across stored memories by query text. Returns matching memory entries ranked by relevance.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        limit: { type: 'number', description: 'Maximum number of results', default: 5 },
        agentGroupId: { type: 'string', description: 'Agent group ID to scope the search' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, params) {
      const query = typeof params.query === 'string' ? params.query : '';
      const limit = typeof params.limit === 'number' ? params.limit : 5;
      const agentGroupId = resolveAgentGroupId(params.agentGroupId, runtime?.agentGroupId ?? process.env.COVE_AGENT_GROUP_ID);

      if (!agentGroupId) {
        return jsonToolResult({ tool: name, query, limit, results: [], error: 'agentGroupId is required' });
      }

      const results = await hybridSearch({
        query,
        db,
        agentGroupId,
        maxResults: limit,
        embedTexts,
        embedderKey: resolveCentralDbPath(runtime),
        embeddingWeight: 0.7,
      });

      return jsonToolResult({
        tool: name,
        query,
        limit,
        results: results.map(({ score: _score, ...memory }) => memory),
      });
    },
  };
}

function createSaveMemoryTool(
  db: Database,
  name: string,
  label: string,
  embedTexts?: EmbedTexts,
  runtime?: CoveToolRuntimeOptions,
): ToolDefinition {
  return {
    name,
    label,
    description: 'Save a new memory entry with optional importance score for later retrieval.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory content to save' },
        importance: { type: 'number', description: 'Importance score from 0 to 1', default: 0.5 },
        agentGroupId: { type: 'string', description: 'Agent group ID to associate the memory with' },
      },
      required: ['content'],
    },
    async execute(_toolCallId, params) {
      const content = typeof params.content === 'string' ? params.content : '';
      const importance = typeof params.importance === 'number' ? params.importance : 0.5;
      const agentGroupId = resolveAgentGroupId(params.agentGroupId, runtime?.agentGroupId ?? process.env.COVE_AGENT_GROUP_ID);

      if (!agentGroupId) {
        return jsonToolResult({ tool: name, content, importance, saved: false, error: 'agentGroupId is required' });
      }

      const memory = await storeMemoryWithEmbedding({
        content,
        agentGroupId,
        importance,
        embedTexts,
        embedderKey: resolveCentralDbPath(runtime),
        db,
      });

      return jsonToolResult({ tool: name, content, importance, saved: true, id: memory.id });
    },
  };
}

function createReadWikiTool(db: Database, name: string, label: string): ToolDefinition {
  return {
    name,
    label,
    description: 'Read a wiki entry by its slug identifier. Returns the full wiki content if found.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Wiki page slug identifier' },
      },
      required: ['slug'],
    },
    async execute(_toolCallId, params) {
      const slug = typeof params.slug === 'string' ? params.slug : '';
      const entry = getWikiEntry(slug, db);

      return jsonToolResult(entry
        ? { tool: name, slug, found: true, entry }
        : { tool: name, slug, found: false });
    },
  };
}

function createSearchWikiTool(
  db: Database,
  name: string,
  label: string,
  runtime?: CoveToolRuntimeOptions,
): ToolDefinition {
  return {
    name,
    label,
    description: 'Search wiki entries by query text. Returns matching wiki entries ranked by relevance.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        limit: { type: 'number', description: 'Maximum number of results', default: 5 },
      },
      required: ['query'],
    },
    async execute(_toolCallId, params) {
      const query = typeof params.query === 'string' ? params.query : '';
      const limit = typeof params.limit === 'number' ? params.limit : 5;
      const results = await hybridSearchWikiEntries(query, db, limit, {
        embedTexts: undefined,
      });

      void runtime;

      return jsonToolResult({ tool: name, query, limit, results });
    },
  };
}

function createSaveWikiTool(db: Database, name: string, label: string): ToolDefinition {
  return {
    name,
    label,
    description: 'Create a wiki entry that is immediately searchable and visible to both agents and humans.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Unique wiki page slug identifier' },
        title: { type: 'string', description: 'Wiki page title' },
        content: { type: 'string', description: 'Markdown content to store' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional wiki tags' },
        provenance: { type: 'string', description: 'Source of the content', default: 'agent' },
        created_by: { type: 'string', description: 'Creator identifier', default: 'agent' },
      },
      required: ['slug', 'title', 'content'],
    },
    async execute(_toolCallId, params) {
      const slug = typeof params.slug === 'string' ? params.slug : '';
      const title = typeof params.title === 'string' ? params.title : '';
      const content = typeof params.content === 'string' ? params.content : '';
      const tags = Array.isArray(params.tags) ? params.tags.map((tag) => String(tag)) : undefined;
      const entry = createWikiEntry({
        slug,
        title,
        content,
        tags,
        provenance: typeof params.provenance === 'string' ? params.provenance : 'agent',
        created_by: typeof params.created_by === 'string' ? params.created_by : 'agent',
        db,
      });

      return jsonToolResult({ tool: name, saved: true, entry });
    },
  };
}

function createStartWorkflowTool(name: string, label: string, runtime?: CoveToolRuntimeOptions): ToolDefinition {
  return {
    name,
    label,
    description: 'Start a host-owned workflow through the workflow bridge API.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow definition name' },
        input: { type: 'object', description: 'Workflow input payload' },
        id: { type: 'string', description: 'Optional caller-supplied workflow instance id' },
      },
      required: ['name', 'input'],
    },
    async execute(_toolCallId, params) {
      try {
        const workflowName = typeof params.name === 'string' ? params.name : '';
        const input = typeof params.input === 'object' && params.input != null && !Array.isArray(params.input)
          ? params.input as Record<string, unknown>
          : {};
        const bridge = createWorkflowBridge({
          runtime: {
            workflowApiBaseUrl: runtime?.workflowApiBaseUrl,
            agentGroupId: runtime?.agentGroupId,
            sessionId: runtime?.sessionId,
          },
        });
        const started = await bridge.startWorkflow({
          ...(typeof params.id === 'string' ? { id: params.id } : {}),
          name: workflowName,
          input,
        });
        return jsonToolResult({ tool: name, instanceId: started.instanceId });
      } catch (error) {
        return workflowToolErrorResult(name, error);
      }
    },
  };
}

function createGetWorkflowTool(name: string, label: string, runtime?: CoveToolRuntimeOptions): ToolDefinition {
  return {
    name,
    label,
    description: 'Fetch a workflow instance from the host workflow bridge API.',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'Workflow instance id' },
      },
      required: ['instanceId'],
    },
    async execute(_toolCallId, params) {
      try {
        const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';
        const bridge = createWorkflowBridge({
          runtime: { workflowApiBaseUrl: runtime?.workflowApiBaseUrl },
        });
        return jsonToolResult({ tool: name, ...(await bridge.getWorkflow(instanceId)) });
      } catch (error) {
        return workflowToolErrorResult(name, error);
      }
    },
  };
}

function createListWorkflowsTool(name: string, label: string, runtime?: CoveToolRuntimeOptions): ToolDefinition {
  return {
    name,
    label,
    description: 'List workflow definitions and instances through the host workflow bridge API.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional workflow name filter' },
        status: { type: 'string', description: 'Optional workflow status filter' },
      },
    },
    async execute(_toolCallId, params) {
      try {
        const bridge = createWorkflowBridge({
          runtime: { workflowApiBaseUrl: runtime?.workflowApiBaseUrl },
        });
        const response = await bridge.listWorkflows({
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(typeof params.status === 'string' ? { status: params.status as 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated' } : {}),
        });
        return jsonToolResult({ tool: name, ...response });
      } catch (error) {
        return workflowToolErrorResult(name, error);
      }
    },
  };
}

function createSignalWorkflowTool(name: string, label: string, runtime?: CoveToolRuntimeOptions): ToolDefinition {
  return {
    name,
    label,
    description: 'Signal a running workflow instance through the host workflow bridge API.',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'Workflow instance id' },
        eventName: { type: 'string', description: 'Signal event name' },
        data: { type: 'object', description: 'Signal payload' },
      },
      required: ['instanceId', 'eventName', 'data'],
    },
    async execute(_toolCallId, params) {
      try {
        const bridge = createWorkflowBridge({
          runtime: { workflowApiBaseUrl: runtime?.workflowApiBaseUrl },
        });
        const response = await bridge.signalWorkflow({
          instanceId: typeof params.instanceId === 'string' ? params.instanceId : '',
          eventName: typeof params.eventName === 'string' ? params.eventName : '',
          data: typeof params.data === 'object' && params.data != null && !Array.isArray(params.data)
            ? params.data as Record<string, unknown>
            : {},
        });
        return jsonToolResult({ tool: name, ...response });
      } catch (error) {
        return workflowToolErrorResult(name, error);
      }
    },
  };
}

function createWaitForWorkflowTool(name: string, label: string, runtime?: CoveToolRuntimeOptions): ToolDefinition {
  return {
    name,
    label,
    description: 'Poll the host workflow bridge API until a workflow instance finishes or times out.',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'Workflow instance id' },
        timeoutMs: { type: 'number', description: 'Optional wait timeout in milliseconds' },
        pollIntervalMs: { type: 'number', description: 'Optional polling interval in milliseconds' },
      },
      required: ['instanceId'],
    },
    async execute(_toolCallId, params) {
      try {
        const bridge = createWorkflowBridge({
          runtime: { workflowApiBaseUrl: runtime?.workflowApiBaseUrl },
        });
        const result = await bridge.waitForWorkflow({
          instanceId: typeof params.instanceId === 'string' ? params.instanceId : '',
          ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
          ...(typeof params.pollIntervalMs === 'number' ? { pollIntervalMs: params.pollIntervalMs } : {}),
        });
        return jsonToolResult({ tool: name, ...result });
      } catch (error) {
        return workflowToolErrorResult(name, error);
      }
    },
  };
}

export function createCoveTools(db?: Database, embedTexts?: EmbedTexts, runtime?: CoveToolRuntimeOptions): ToolDefinition[] {
  const tools = [
    createStartWorkflowTool('start-workflow', 'Start Workflow', runtime),
    createGetWorkflowTool('get-workflow', 'Get Workflow', runtime),
    createListWorkflowsTool('list-workflows', 'List Workflows', runtime),
    createSignalWorkflowTool('signal-workflow', 'Signal Workflow', runtime),
    createWaitForWorkflowTool('wait-for-workflow', 'Wait For Workflow', runtime),
  ];

  const hasKnowledgeDb = db != null || resolveCentralDbPath(runtime) != null;

  if (!hasKnowledgeDb) {
    return tools;
  }

  const toolDb = db ?? openCentralDb(runtime);

  if (toolDb == null) {
    return tools;
  }

  return [
    ...tools,
    createSearchMemoriesTool(toolDb, 'memory_search', 'Memory Search', embedTexts, runtime),
    createSaveMemoryTool(toolDb, 'memory_store', 'Memory Store', embedTexts, runtime),
    createReadWikiTool(toolDb, 'wiki_get', 'Wiki Get'),
    createSearchWikiTool(toolDb, 'wiki_search', 'Wiki Search', runtime),
    createSaveWikiTool(toolDb, 'wiki_save', 'Wiki Save'),
    createSearchMemoriesTool(toolDb, 'search_memories', 'Search Memories', embedTexts, runtime),
    createSaveMemoryTool(toolDb, 'save_memory', 'Save Memory', embedTexts, runtime),
    createReadWikiTool(toolDb, 'read_wiki', 'Read Wiki'),
    createSearchWikiTool(toolDb, 'search_wiki', 'Search Wiki', runtime),
    createSaveWikiTool(toolDb, 'save_wiki', 'Save Wiki'),
  ];
}
