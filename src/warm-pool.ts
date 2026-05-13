import fs from 'node:fs';
import path from 'node:path';

import { getImageName } from './container/image.ts';
import { killContainer } from './container/kill.ts';
import { getActiveContainers } from './container/spawn.ts';
import { openInboundDb } from './session/inbound.ts';
import { openOutboundDb, readProcessingAck } from './session/outbound.ts';
import type { WarmPool } from './shared/types.ts';

type WarmPoolOptions = {
  stateDir: string;
  minSize: number;
  maxSize: number;
  imageName?: string;
  startingTimeoutMs?: number;
  maintainIntervalMs?: number;
  spawnContainer(
    sessionId: string,
    containerName: string,
    sessionDir: string,
    imageName: string,
  ): boolean;
};

type WarmPoolEntry = {
  sessionId: string;
  containerName: string;
  sessionDir: string;
  status: 'starting' | 'ready' | 'allocated';
  startedAt: number;
};

type Allocation = {
  sessionId: string;
  containerName: string;
  sessionDir: string;
};

function warmSessionDir(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'warm', sessionId);
}

function seedWarmSessionConfig(sessionDir: string, sessionId: string): void {
  const inboundDb = openInboundDb(sessionDir);

  try {
    inboundDb.exec('DELETE FROM session_config');
    inboundDb.prepare(
      `INSERT INTO session_config (provider, model, thinking_level, api_key, workspace, extra_env, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'auto',
      sessionId,
      null,
      null,
      null,
      JSON.stringify({ COVE_SESSION_ID: sessionId }),
      null,
    );
  } finally {
    inboundDb.close();
  }
}

function isReady(entry: WarmPoolEntry): boolean {
  const outboundDbPath = path.join(entry.sessionDir, 'outbound.db');

  if (!fs.existsSync(outboundDbPath)) {
    return false;
  }

  const outboundDb = openOutboundDb(entry.sessionDir);

  try {
    return readProcessingAck(outboundDb, entry.sessionId) != null;
  } catch {
    return false;
  } finally {
    outboundDb.close();
  }
}

function countByStatus(entries: WarmPoolEntry[]) {
  return {
    ready: entries.filter((entry) => entry.status === 'ready').length,
    allocated: entries.filter((entry) => entry.status === 'allocated').length,
    starting: entries.filter((entry) => entry.status === 'starting').length,
  };
}

export function createWarmPool(options: WarmPoolOptions): WarmPool {
  const entries: WarmPoolEntry[] = [];
  const imageName = options.imageName ?? getImageName();
  const startingTimeoutMs = options.startingTimeoutMs ?? 15_000;
  const maintainIntervalMs = options.maintainIntervalMs ?? 5_000;
  let timer: Timer | undefined;
  let counter = 0;

  function nextSessionId(): string {
    counter += 1;
    return `warm-${Date.now()}-${counter}`;
  }

  function nextContainerName(sessionId: string): string {
    return `cove-warm-${sessionId}`;
  }

  function refreshReadyEntries(): void {
    for (const entry of entries) {
      if (entry.status === 'starting' && isReady(entry)) {
        entry.status = 'ready';
      }
    }
  }

  function evictStuckStartingEntries(): void {
    const now = Date.now();

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry == null || entry.status !== 'starting') {
        continue;
      }

      if (now - entry.startedAt < startingTimeoutMs) {
        continue;
      }

      killContainer(entry.sessionId);
      getActiveContainers().delete(entry.sessionId);
      entries.splice(index, 1);
    }
  }

  function spawnOne(): void {
    if (entries.length >= options.maxSize) {
      return;
    }

    const sessionId = nextSessionId();
    const containerName = nextContainerName(sessionId);
    const sessionDir = warmSessionDir(options.stateDir, sessionId);

    fs.mkdirSync(sessionDir, { recursive: true });
    seedWarmSessionConfig(sessionDir, sessionId);

    const entry: WarmPoolEntry = {
      sessionId,
      containerName,
      sessionDir,
      status: 'starting',
      startedAt: Date.now(),
    };
    entries.push(entry);

    if (!options.spawnContainer(sessionId, containerName, sessionDir, imageName)) {
      const index = entries.indexOf(entry);

      if (index >= 0) {
        entries.splice(index, 1);
      }
    }
  }

  function maintain(): void {
    refreshReadyEntries();
    evictStuckStartingEntries();

    const stats = countByStatus(entries);
    const deficit = options.minSize - (stats.ready + stats.starting);

    for (let index = 0; index < deficit; index += 1) {
      if (entries.length >= options.maxSize) {
        break;
      }

      spawnOne();
    }
  }

  return {
    async start(): Promise<void> {
      maintain();
      timer = setInterval(maintain, maintainIntervalMs);
    },

    async stop(): Promise<void> {
      if (timer != null) {
        clearInterval(timer);
        timer = undefined;
      }

      for (const entry of entries.splice(0)) {
        killContainer(entry.sessionId);
        getActiveContainers().delete(entry.sessionId);
      }
    },

    async acquire(): Promise<Allocation | null> {
      refreshReadyEntries();
      const entry = entries.find((candidate) => candidate.status === 'ready');

      if (entry == null) {
        return null;
      }

      entry.status = 'allocated';
      maintain();

      return {
        sessionId: entry.sessionId,
        containerName: entry.containerName,
        sessionDir: entry.sessionDir,
      };
    },

    consume(sessionId: string): void {
      const index = entries.findIndex((entry) => entry.sessionId === sessionId);

      if (index >= 0) {
        entries.splice(index, 1);
      }

      maintain();
    },

    release(sessionId: string): void {
      const entry = entries.find((candidate) => candidate.sessionId === sessionId);

      if (entry == null) {
        return;
      }

      entry.status = 'ready';
    },

    getStats() {
      return countByStatus(entries);
    },
  };
}
