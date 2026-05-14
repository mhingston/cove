import { Database } from 'bun:sqlite';
import path from 'node:path';

import { type Memory } from './external.ts';
import { loadPersona } from './persona.ts';
import { buildWorkingContext } from './working.ts';
import { hybridSearch } from '../knowledge/search.ts';
import { getStateDir } from '../db/index.ts';
import type { ChatMessage } from '../shared/types.ts';

type SearchMemories = (params: {
  query: string;
  agentGroupId: string;
  maxResults: number;
  db: Database;
}) => Promise<Array<Memory>>;

type AssembleContextParams = {
  agentGroupId: string;
  sessionId: string;
  messages: ChatMessage[];
  db?: Database;
  sessionDir?: string;
  persona?: string;
  searchMemories?: SearchMemories;
  createDb?: (dbPath: string) => Database;
};

function getLatestUserQuery(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message?.role !== 'user') {
      continue;
    }

    if (message.content.trim()) {
      return message.content;
    }
  }

  return null;
}

export async function assembleContext(params: AssembleContextParams): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];

  const persona = loadPersona(params.agentGroupId, {
    personaText: params.persona,
    db: params.db,
  });

  if (persona != null) {
    result.push({ role: 'system', content: persona });
  }

  if (params.sessionDir != null) {
    result.push(...buildWorkingContext(params.sessionDir));
  }

  const latestUserQuery = getLatestUserQuery(params.messages);

  if (latestUserQuery != null) {
    const searchMemories = params.searchMemories ?? (async (searchParams) => hybridSearch(searchParams));
    const ownsDb = params.db == null;
    const db = params.db ?? (params.createDb ?? ((dbPath: string) => new Database(dbPath)))(
      path.join(getStateDir(), 'cove.db'),
    );

    try {
      const memories = await searchMemories({
        query: latestUserQuery,
        agentGroupId: params.agentGroupId,
        maxResults: 3,
        db,
      }).catch((error) => {
        if (!ownsDb) {
          throw error;
        }

        return [];
      });

      for (const memory of memories.slice(0, 3)) {
        result.push({ role: 'system', content: memory.content });
      }
    } finally {
      if (ownsDb) {
        db.close();
      }
    }
  }

  result.push(...params.messages);
  return result;
}

export type { AssembleContextParams };
