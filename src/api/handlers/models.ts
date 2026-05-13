import type { AppContext, AgentGroupSummaryRow, ModelResponseItem } from '../../shared/types.ts';

function toUnixSeconds(iso: string): number {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? 0 : Math.floor(timestamp / 1000);
}

export function handleModels({ db }: AppContext): Response {
  const rows = db
    .prepare(
      `SELECT id, name, description, created_at, updated_at
       FROM agent_groups
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as AgentGroupSummaryRow[];

  const data: ModelResponseItem[] = rows.map((row) => ({
    id: row.id,
    object: 'model',
    created: toUnixSeconds(row.created_at),
    owned_by: 'cove',
  }));

  return Response.json({ object: 'list', data });
}
