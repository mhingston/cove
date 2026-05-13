import { Database } from 'bun:sqlite';
import fs from 'node:fs';

import {
  getActiveContainerCount,
  getActiveContainers,
  isContainerRunning,
  killContainer,
  restartContainer,
  type ContainerEntry,
} from './container/spawn.ts';
import { type ProcessingAckRow, type SweepHandle } from './shared/types.ts';
import { getInboundDbPath } from './session/inbound.ts';
import { readProcessingAck } from './session/outbound.ts';
import { getOutboundDbPath } from './session/outbound.ts';

export type SweepOptions = {
  intervalMs: number;
  ceilingMs: number;
  claimStuckMs: number;
};

export type StuckAction =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; reason: string }
  | { action: 'kill-claim'; reason: string };

type ProgressObservation = {
  progressKey: string;
  observedAt: number;
  ackSessionId: string;
  heartbeatBaselineAt: number;
  startedAt: number;
};

type SweepDeps = {
  getActiveContainers: () => Map<string, ContainerEntry>;
  getActiveContainerCount: () => number;
  isContainerRunning: (sessionId: string) => boolean | Promise<boolean>;
  restartContainer: (sessionId: string, reason?: string) => boolean;
  killContainer: (sessionId: string, reason?: string) => void;
  readAck: (sessionId: string, sessionDir: string) => ProcessingAckRow | null | Promise<ProcessingAckRow | null>;
  readMaxInboundSeq: (sessionDir: string) => number | null | Promise<number | null>;
  now: () => number;
  log: (message: string) => void;
};

function readAckFromSessionDir(sessionId: string, sessionDir: string): ProcessingAckRow | null {
  const outboundDbPath = getOutboundDbPath(sessionDir);

  if (!fs.existsSync(outboundDbPath)) {
    return null;
  }

  const db = new Database(outboundDbPath, { readonly: true });

  try {
    return readProcessingAck(db, sessionId);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readMaxInboundSeqFromSessionDir(sessionDir: string): number | null {
  const inboundDbPath = getInboundDbPath(sessionDir);

  if (!fs.existsSync(inboundDbPath)) {
    return null;
  }

  const db = new Database(inboundDbPath, { readonly: true });

  try {
    const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM messages_in').get() as
      | { maxSeq: number | null }
      | null;
    return row?.maxSeq ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const defaultDeps: SweepDeps = {
  getActiveContainers,
  getActiveContainerCount,
  isContainerRunning,
  restartContainer,
  killContainer,
  readAck: readAckFromSessionDir,
  readMaxInboundSeq: readMaxInboundSeqFromSessionDir,
  now: () => Date.now(),
  log: (message: string) => console.warn(message),
};

function getAckSessionId(sessionId: string, entry: ContainerEntry): string {
  return entry.options.envVars?.COVE_SESSION_ID ?? sessionId;
}

function getProgressKey(ack: ProcessingAckRow | null, maxInboundSeq: number | null): string {
  const lastInSeq = ack?.last_in_seq ?? null;
  const lastOutSeq = ack?.last_out_seq ?? null;
  const containerId = ack?.container_id ?? null;
  const outstanding = maxInboundSeq != null && (lastInSeq == null || maxInboundSeq > lastInSeq);
  return JSON.stringify([lastInSeq, lastOutSeq, containerId, outstanding]);
}

function restartOrKill(
  sessionId: string,
  reason: string,
  observations: Map<string, ProgressObservation>,
  deps: SweepDeps,
): void {
  const restarted = deps.restartContainer(sessionId, reason);

  observations.delete(sessionId);
  if (!restarted) {
    deps.killContainer(sessionId, reason);
  }
}

export function decideStuckAction(options: {
  heartbeatAgeMs: number;
  ceilingMs: number;
  claimAgeMs: number;
  claimStuckMs: number;
}): StuckAction {
  if (options.heartbeatAgeMs > options.ceilingMs) {
    return {
      action: 'kill-ceiling',
      reason: `heartbeat age ${options.heartbeatAgeMs}ms exceeded ${options.ceilingMs}ms`,
    };
  }

  if (options.claimAgeMs > options.claimStuckMs) {
    return {
      action: 'kill-claim',
      reason: `claim age ${options.claimAgeMs}ms exceeded ${options.claimStuckMs}ms`,
    };
  }

  return { action: 'ok' };
}

export function startSweep(options: SweepOptions, overrides: Partial<SweepDeps> = {}): SweepHandle {
  const deps: SweepDeps = { ...defaultDeps, ...overrides };
  const observations = new Map<string, ProgressObservation>();
  let lastTick: Promise<void> = Promise.resolve();
  let tickInFlight = false;
  let stopping = false;

  const tick = async (): Promise<void> => {
    const activeContainers = deps.getActiveContainers();
    const activeSessionIds = new Set(activeContainers.keys());

    for (const sessionId of observations.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        observations.delete(sessionId);
      }
    }

    if (deps.getActiveContainerCount() === 0) {
      return;
    }

    for (const [sessionId, entry] of activeContainers.entries()) {
      try {
        if (!(await deps.isContainerRunning(sessionId))) {
          restartOrKill(sessionId, 'container exited', observations, deps);
          continue;
        }

        const now = deps.now();
        const ackSessionId = getAckSessionId(sessionId, entry);
        const ack = await deps.readAck(ackSessionId, entry.options.sessionDir);
        const maxInboundSeq = await deps.readMaxInboundSeq(entry.options.sessionDir);
        const previousObservation = observations.get(sessionId);
        const heartbeatBaselineAt = !ack && ackSessionId !== sessionId
          ? (previousObservation?.ackSessionId === ackSessionId ? previousObservation.heartbeatBaselineAt : now)
          : entry.startedAt;
        const heartbeatAgeMs = ack?.heartbeat_at == null
          ? Math.max(0, now - heartbeatBaselineAt)
          : Math.max(0, now - new Date(ack.heartbeat_at).getTime());

        if (heartbeatAgeMs > options.ceilingMs) {
          restartOrKill(
            sessionId,
            `heartbeat stale for ${heartbeatAgeMs}ms`,
            observations,
            deps,
          );
          continue;
        }

        const progressKey = getProgressKey(ack, maxInboundSeq);
        const shouldResetObservation =
          previousObservation == null
          || previousObservation.progressKey !== progressKey
          || previousObservation.ackSessionId !== ackSessionId
          || previousObservation.heartbeatBaselineAt !== heartbeatBaselineAt
          || previousObservation.startedAt !== entry.startedAt;

        const observation = shouldResetObservation
          ? {
              progressKey,
              observedAt: now,
              ackSessionId,
              heartbeatBaselineAt,
              startedAt: entry.startedAt,
            }
          : previousObservation;

        if (shouldResetObservation) {
          observations.set(sessionId, observation);
          continue;
        }

        const decision = decideStuckAction({
          heartbeatAgeMs,
          ceilingMs: options.ceilingMs,
          claimAgeMs: Math.max(0, now - observation.observedAt),
          claimStuckMs: options.claimStuckMs,
        });

        if (decision.action === 'kill-claim') {
          const hasOutstandingWork = maxInboundSeq != null && (ack?.last_in_seq == null || maxInboundSeq > ack.last_in_seq);

          if (hasOutstandingWork) {
            restartOrKill(sessionId, decision.reason, observations, deps);
          }
        }
      } catch (error) {
        observations.delete(sessionId);
        deps.log(`[sweep] session ${sessionId} read failed: ${String(error)}`);
      }
    }
  };

  const runTick = (): Promise<void> => {
    if (tickInFlight || stopping) {
      return lastTick;
    }

    tickInFlight = true;
    lastTick = tick()
      .catch((error) => {
        deps.log(`[sweep] tick failed: ${String(error)}`);
      })
      .finally(() => {
        tickInFlight = false;
      });

    return lastTick;
  };

  const timer = setInterval(() => {
    void runTick();
  }, options.intervalMs);

  return {
    async stop(): Promise<void> {
      stopping = true;
      clearInterval(timer);
      await lastTick;
    },
  };
}
