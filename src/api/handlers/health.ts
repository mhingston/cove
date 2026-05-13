export function handleHealth(): Response {
  return Response.json({ ok: true, phase: 'Phase 5' });
}
