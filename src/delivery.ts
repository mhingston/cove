import type { Database } from 'bun:sqlite';

import { readProcessingAck, readVisibleOutboundMessages } from './session/outbound.ts';
import type {
  DeliveryDbReader,
  OutboundMessageRow,
  WorkflowActionRequestMetadata,
  WorkflowActionResultMetadata,
} from './shared/types.ts';

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
  let expectedSeq = Math.max(baselineOutSeq, 1) + 2;

  for (const message of messages) {
    while (expectedSeq < message.seq) {
      missing.push(expectedSeq);
      expectedSeq += 2;
    }

    expectedSeq = message.seq + 2;
  }

  return missing;
}

function withDeliveryDb<T>(options: DeliveryDbReader, read: (db: Database) => T): T {
  if ('db' in options) {
    return read(options.db);
  }

  if (!('openDb' in options)) {
    throw new Error('Delivery polling requires either db or openDb');
  }

  const db = options.openDb();

  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function readDeliverableMessages(options: {
  sessionId: string;
  baselineOutSeq: number;
} & DeliveryDbReader): OutboundMessageRow[] | null {
  return withDeliveryDb(options, (db) => {
    const visibleMessages = readVisibleOutboundMessages(db, options.baselineOutSeq);

    if (visibleMessages.length === 0) {
      return null;
    }

    if (findMissingOutboundSeqs(visibleMessages, options.baselineOutSeq).length > 0) {
      return null;
    }

    const ack = readProcessingAck(db, options.sessionId);
    const latestVisibleSeq = visibleMessages[visibleMessages.length - 1]?.seq ?? null;

    if (ack?.last_out_seq !== latestVisibleSeq) {
      return null;
    }

    return visibleMessages;
  });
}

function readDeliverableWorkflowActionResult(options: {
  sessionId: string;
  baselineOutSeq: number;
  requestId: string;
} & DeliveryDbReader): WorkflowActionResultMetadata | null {
  const messages = readDeliverableMessages(options);

  if (messages == null) {
    return null;
  }

  for (const message of messages) {
    if (message.metadata == null) {
      continue;
    }

    let metadata: unknown;

    try {
      metadata = JSON.parse(message.metadata);
    } catch {
      continue;
    }

    if (metadata == null || typeof metadata !== 'object') {
      continue;
    }

    const candidate = metadata as Partial<WorkflowActionResultMetadata>;

    if (
      candidate.type === 'workflow_action_result'
      && candidate.request_id === options.requestId
      && (candidate.status === 'completed' || candidate.status === 'blocked' || candidate.status === 'error')
    ) {
      return candidate as WorkflowActionResultMetadata;
    }
  }

  return null;
}

async function pollUntilTimeout(options: {
  sessionId: string;
  baselineOutSeq: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} & DeliveryDbReader): Promise<OutboundMessageRow[] | null> {
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
  sessionId: string;
  baselineOutSeq: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} & DeliveryDbReader): Promise<OutboundMessageRow[]> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const delivered = await pollUntilTimeout({
      ...options,
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

    const visibleMessages = withDeliveryDb(options, (db) => readVisibleOutboundMessages(db, options.baselineOutSeq));
    const hasGaps = findMissingOutboundSeqs(visibleMessages, options.baselineOutSeq).length > 0;

    if (!hasGaps || attempt === 2) {
      throw new DeliveryTimeoutError({ attempts: attempt, hasGaps });
    }
  }

  throw new DeliveryTimeoutError({ attempts: 2, hasGaps: false });
}

export async function pollForWorkflowActionResult(options: {
  sessionId: string;
  baselineOutSeq?: number;
  requestId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} & DeliveryDbReader): Promise<WorkflowActionResultMetadata> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const baselineOutSeq = options.baselineOutSeq ?? 0;
  const startedAt = now();

  while (now() - startedAt < timeoutMs) {
    const delivered = readDeliverableWorkflowActionResult({
      ...options,
      baselineOutSeq,
    });

    if (delivered != null) {
      return delivered;
    }

    await sleep(pollIntervalMs);
  }

  const visibleMessages = withDeliveryDb(options, (db) => readVisibleOutboundMessages(db, baselineOutSeq));
  const hasGaps = findMissingOutboundSeqs(visibleMessages, baselineOutSeq).length > 0;
  throw new DeliveryTimeoutError({ attempts: 1, hasGaps });
}
