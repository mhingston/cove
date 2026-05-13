export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface ApprovalRecord {
  id: string;
  agent_group_id: string;
  session_id: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
  status: ApprovalStatus;
  requested_at: string;
  responded_at?: string;
}

export interface ApprovalStore {
  create(request: {
    agent_group_id: string;
    session_id: string;
    tool_name: string;
    tool_args?: Record<string, unknown>;
  }): ApprovalRecord;
  get(id: string): ApprovalRecord | null;
  list(filter?: { status?: string; agent_group_id?: string }): ApprovalRecord[];
  approve(id: string): ApprovalRecord;
  decline(id: string): ApprovalRecord;
  isExpired(record: ApprovalRecord, ttlMs?: number): boolean;
}

const DEFAULT_TTL_MS = 300_000;

export class ApprovalStoreInMemory implements ApprovalStore {
  private store = new Map<string, ApprovalRecord>();

  create(request: {
    agent_group_id: string;
    session_id: string;
    tool_name: string;
    tool_args?: Record<string, unknown>;
  }): ApprovalRecord {
    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      agent_group_id: request.agent_group_id,
      session_id: request.session_id,
      tool_name: request.tool_name,
      tool_args: request.tool_args,
      status: 'pending',
      requested_at: new Date().toISOString(),
    };

    this.store.set(record.id, record);

    return record;
  }

  get(id: string): ApprovalRecord | null {
    return this.store.get(id) ?? null;
  }

  list(filter?: { status?: string; agent_group_id?: string }): ApprovalRecord[] {
    let records = Array.from(this.store.values());

    if (filter?.agent_group_id) {
      records = records.filter((record) => record.agent_group_id === filter.agent_group_id);
    }

    if (filter?.status) {
      records = records.filter((record) => record.status === filter.status);
    }

    return records;
  }

  approve(id: string): ApprovalRecord {
    const record = this.getPendingRecord(id);

    if (record.status !== 'pending') {
      return record;
    }

    record.status = 'approved';
    record.responded_at = new Date().toISOString();

    return record;
  }

  decline(id: string): ApprovalRecord {
    const record = this.getPendingRecord(id);

    if (record.status !== 'pending') {
      return record;
    }

    record.status = 'declined';
    record.responded_at = new Date().toISOString();

    return record;
  }

  isExpired(record: ApprovalRecord, ttlMs: number = DEFAULT_TTL_MS): boolean {
    return Date.now() - new Date(record.requested_at).getTime() >= ttlMs;
  }

  private getPendingRecord(id: string): ApprovalRecord {
    const record = this.store.get(id);

    if (record == null) {
      throw new NotFoundError(`Approval record not found: ${id}`);
    }

    if (record.status !== 'pending') {
      return record;
    }

    if (this.isExpired(record)) {
      throw new Error(`Approval record ${id} has expired`);
    }

    return record;
  }
}
