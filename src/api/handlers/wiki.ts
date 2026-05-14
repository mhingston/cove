import type { Database } from 'bun:sqlite';

import {
  createWikiEntry,
  deleteWikiEntry,
  DuplicateWikiEntryError,
  getWikiEntry,
  hybridSearchWikiEntries,
  InvalidWikiFieldError,
  InvalidWikiSlugError,
  listWikiEntries,
  updateWikiEntry,
} from '../../knowledge/wiki.ts';

type WikiCreateBody = {
  slug: string;
  title: string;
  content: string;
  tags?: string[];
  provenance?: string;
  created_by?: string;
};

type WikiUpdateBody = {
  title?: string;
  content?: string;
  tags?: string[];
  provenance?: string;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function validateWikiCreateBody(body: unknown): WikiCreateBody {
  if (!isRecord(body)) {
    throw new Error('Wiki payload must be a JSON object');
  }

  if (typeof body.slug !== 'string' || typeof body.title !== 'string' || typeof body.content !== 'string') {
    throw new Error('slug, title, and content are required string fields');
  }

  if (body.provenance !== undefined && typeof body.provenance !== 'string') {
    throw new Error('provenance must be a string');
  }

  if (body.created_by !== undefined && typeof body.created_by !== 'string') {
    throw new Error('created_by must be a string');
  }

  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))) {
    throw new Error('tags must be an array of strings');
  }

  return {
    slug: body.slug,
    title: body.title,
    content: body.content,
    tags: body.tags,
    provenance: body.provenance,
    created_by: body.created_by,
  };
}

function normalizeQuery(request: Request): string | null {
  const query = new URL(request.url).searchParams.get('q');
  const normalized = query?.trim();

  return normalized ? normalized : null;
}

function validateWikiUpdateBody(body: unknown): WikiUpdateBody {
  if (!isRecord(body)) {
    throw new Error('Wiki payload must be a JSON object');
  }

  if (body.title !== undefined && typeof body.title !== 'string') {
    throw new Error('title must be a string');
  }

  if (body.content !== undefined && typeof body.content !== 'string') {
    throw new Error('content must be a string');
  }

  if (body.provenance !== undefined && typeof body.provenance !== 'string') {
    throw new Error('provenance must be a string');
  }

  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))) {
    throw new Error('tags must be an array of strings');
  }

  return {
    title: body.title,
    content: body.content,
    tags: body.tags,
    provenance: body.provenance,
  };
}

export async function handleCreateWiki(request: Request, db: Database): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  let payload: WikiCreateBody;

  try {
    payload = validateWikiCreateBody(body);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid wiki payload' }, 400);
  }

  try {
    return jsonResponse(createWikiEntry({ ...payload, db }), 201);
  } catch (error) {
    if (error instanceof InvalidWikiSlugError || error instanceof InvalidWikiFieldError) {
      return jsonResponse({ error: error.message }, 400);
    }

    if (error instanceof DuplicateWikiEntryError) {
      return jsonResponse({ error: error.message }, 409);
    }

    return jsonResponse({ error: 'Failed to create wiki entry' }, 500);
  }
}

export async function handleListOrSearchWiki(request: Request, db: Database): Promise<Response> {
  try {
    const query = normalizeQuery(request);
    const entries = query == null ? listWikiEntries(db) : await hybridSearchWikiEntries(query, db);
    return jsonResponse(entries, 200);
  } catch {
    return jsonResponse({ error: 'Failed to load wiki entries' }, 500);
  }
}

export function handleGetWiki(_request: Request, db: Database, params: { slug: string }): Response {
  try {
    const entry = getWikiEntry(params.slug, db);

    if (entry == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse(entry, 200);
  } catch {
    return jsonResponse({ error: 'Failed to load wiki entry' }, 500);
  }
}

export async function handleUpdateWiki(request: Request, db: Database, params: { slug: string }): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  let payload: WikiUpdateBody;

  try {
    payload = validateWikiUpdateBody(body);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid wiki payload' }, 400);
  }

  try {
    const entry = updateWikiEntry(params.slug, payload, db);

    if (entry == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse(entry, 200);
  } catch (error) {
    if (error instanceof InvalidWikiSlugError || error instanceof InvalidWikiFieldError) {
      return jsonResponse({ error: error.message }, 400);
    }

    return jsonResponse({ error: 'Failed to update wiki entry' }, 500);
  }
}

export function handleDeleteWiki(_request: Request, db: Database, params: { slug: string }): Response {
  try {
    const deleted = deleteWikiEntry(params.slug, db);

    if (!deleted) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: 'Failed to delete wiki entry' }, 500);
  }
}
