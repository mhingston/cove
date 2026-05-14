import type { Database } from 'bun:sqlite';

import type { Scheduler } from '../shared/types.ts';
import { createRunAgentPrompt } from './run-agent-prompt.ts';
import {
  getSchedule,
  listSchedules,
  markScheduleRunFailed,
  markScheduleRunNotImplemented,
  markScheduleRunSucceeded,
  type ScheduleRecord,
} from './schedules.ts';

type RunAgentPrompt = ReturnType<typeof createRunAgentPrompt>;

export type SchedulerRuntimeSync = {
  upsertSchedule(id: string): void;
  removeSchedule(id: string): void;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function compareSchedules(left: ScheduleRecord, right: ScheduleRecord): number {
  const nextRunAtComparison = (left.next_run_at ?? '').localeCompare(right.next_run_at ?? '');

  if (nextRunAtComparison !== 0) {
    return nextRunAtComparison;
  }

  const createdAtComparison = left.created_at.localeCompare(right.created_at);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

let scheduleRuntimeSync: SchedulerRuntimeSync | null = null;
let registeredRunAgentPrompt: RunAgentPrompt | null = null;

export function setScheduleRuntimeSync(sync: SchedulerRuntimeSync | null): void {
  scheduleRuntimeSync = sync;
}

export function registerRunAgentPrompt(runAgentPrompt: RunAgentPrompt | null): void {
  registeredRunAgentPrompt = runAgentPrompt;
}

export function getRegisteredRunAgentPrompt(): RunAgentPrompt | null {
  return registeredRunAgentPrompt;
}

export function upsertSchedule(id: string): void {
  scheduleRuntimeSync?.upsertSchedule(id);
}

export function removeSchedule(id: string): void {
  scheduleRuntimeSync?.removeSchedule(id);
}

export class CronScheduler implements Scheduler, SchedulerRuntimeSync {
  readonly pollIntervalMs: number;

  #db: Database;
  #now: () => Date;
  #sleep: (ms: number) => Promise<void>;
  #runAgentPrompt: RunAgentPrompt;
  #running = false;
  #loop: Promise<void> | null = null;
  #waiting: Deferred | null = null;
  #wakeRequested = false;

  constructor(options: {
    db: Database;
    pollIntervalMs?: number;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    runAgentPrompt: RunAgentPrompt;
  }) {
    this.#db = options.db;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    this.#runAgentPrompt = options.runAgentPrompt;
  }

  async start(): Promise<void> {
    if (this.#loop != null) {
      return;
    }

    this.#running = true;
    this.#loop = this.#runLoop();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#requestWake();
    await this.#loop;
    this.#loop = null;
  }

  upsertSchedule(_id: string): void {
    this.#requestWake();
  }

  removeSchedule(_id: string): void {
    this.#requestWake();
  }

  async #runLoop(): Promise<void> {
    try {
      while (this.#running) {
        await this.#runIteration();

        if (!this.#running) {
          break;
        }

        await this.#waitForNextIteration();
      }
    } finally {
      this.#waiting = null;
      this.#wakeRequested = false;
    }
  }

  async #runIteration(): Promise<void> {
    const nowIso = this.#now().toISOString();
    const dueSchedules = listSchedules({ db: this.#db })
      .filter((schedule) => schedule.next_run_at != null && schedule.next_run_at <= nowIso)
      .sort(compareSchedules);

    for (const schedule of dueSchedules) {
      if (!schedule.enabled) {
        continue;
      }

      try {
        if (schedule.mode !== 'agent') {
          markScheduleRunNotImplemented({
            db: this.#db,
            id: schedule.id,
            ranAt: nowIso,
          });
          continue;
        }

        const result = await this.#runAgentPrompt({ schedule });

        try {
          markScheduleRunSucceeded({
            db: this.#db,
            id: schedule.id,
            ranAt: result.lastRunAt,
          });
        } catch {
          continue;
        }
      } catch {
        try {
          markScheduleRunFailed({
            db: this.#db,
            id: schedule.id,
            ranAt: nowIso,
          });
        } catch {
          continue;
        }
      }
    }
  }

  async #waitForNextIteration(): Promise<void> {
    if (this.#wakeRequested) {
      this.#wakeRequested = false;
      return;
    }

    const waiting = createDeferred();
    this.#waiting = waiting;

    try {
      await Promise.race([
        this.#sleep(this.pollIntervalMs),
        waiting.promise,
      ]);
    } finally {
      if (this.#waiting === waiting) {
        this.#waiting = null;
      }
      this.#wakeRequested = false;
    }
  }

  #requestWake(): void {
    this.#wakeRequested = true;
    this.#waiting?.resolve();
  }
}

export function createScheduler(db: Database): Scheduler {
  if (registeredRunAgentPrompt == null) {
    throw new Error('runAgentPrompt is not initialized');
  }

  return new CronScheduler({
    db,
    runAgentPrompt: registeredRunAgentPrompt,
  });
}
