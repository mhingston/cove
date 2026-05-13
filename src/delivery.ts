import type { Database } from 'bun:sqlite';

import { readProcessingAck, readVisibleOutboundMessages } from './session/outbound.ts';
import type { OutboundMessageRow } from './shared/types.ts';

export class DeliveryTimeoutError extends Error {
  attempts: number;
  hasGaps: boolean;
  statusCode: number;

  constructor(options: { attempts: number; hasGaps: boolean }) {
    super('Delivery verification timed out');
    this.name = 'DeliveryTimeoutError';
    this.attempts = options.attempts;
    this.hasGaps = options.hasGaps;
    this.statusCode = 504;
  }
}

export function findMissingOutboundSeqs<T extends { seq: number }>(
  messages: T[],
  baselineOutSeq: number,
): number[] {
  const missing: number[] = [];
  let expectedSeq = baselineOutSeq + 2;

  for (const message of messages) {
    while (expectedSeq < message.seq) {
      missing.push(expectedSeq);
      expectedSeq += 2;
    }

    expectedSeq = message.seq + 2;
  }

  return missing;
}

export function readDeliverableMessages(options: {
  db: Database;
  sessionId: string;
  baselineOutSeq: number;
}): OutboundMessageRow[] | null {
  const visibleMessages = readVisibleOutboundMessages(options.db, options.baselineOutSeq);

  if (visibleMessages.length === 0) {
    return null;
  }

  if (findMissingOutboundSeqs(visibleMessages, options.baselineOutSeq).length > 0) {
    return null;
  }

  const ack = readProcessingAck(options.db, options.sessionId);
  const latestVisibleSeq = visibleMessages[visibleMessages.length - 1]?.seq ?? null;

  if (ack?.last_out_seq !== latestVisibleSeq) {
    return null;
  }

  return visibleMessages;
}

async function pollUntilTimeout(options: {
  db: Database;
  sessionId: string;
  baselineOutSeq: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<OutboundMessageRow[] | null> {
  const startedAt = options.now();

  while (options.now() - startedAt < options.timeoutMs) {
    const messages = readDeliverableMessages(options);

    if (messages != null) {
      return messages;
    }

    await options.sleep(options.pollIntervalMs);
  }

  return null;
}

export async function pollForResponse(options: {
  db: Database;
  sessionId: string;
  baselineOutSeq: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OutboundMessageRow[]> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const delivered = await pollUntilTimeout({
      db: options.db,
      sessionId: options.sessionId,
      baselineOutSeq: options.baselineOutSeq,
      timeoutMs,
      pollIntervalMs,
      now,
      sleep,
    });

    if (delivered != null) {
      return delivered;
    }

    const visibleMessages = readVisibleOutboundMessages(options.db, options.baselineOutSeq);
    const hasGaps = findMissingOutboundSeqs(visibleMessages, options.baselineOutSeq).length > 0;

    if (!hasGaps || attempt === 2) {
      throw new DeliveryTimeoutError({ attempts: attempt, hasGaps });
    }
  }

  throw new DeliveryTimeoutError({ attempts: 2, hasGaps: false });
}
