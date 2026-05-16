# API Reference

## Conventions

- All public routes are served by `src/api/server.ts`.
- JSON routes return `application/json` unless noted otherwise.
- Unknown routes return `404` with `{ "error": "Not Found" }`.
- Public model ids are agent-group ids, not raw provider model names.

## `GET /healthz`

Returns the health payload used by the public API contract.

Response:

```json
{
  "ok": true
}
```

## `GET /v1/models`

Lists agent groups as OpenAI-style models.

Response shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "support-default",
      "object": "model",
      "created": 1767225600,
      "owned_by": "cove"
    }
  ]
}
```

## `POST /v1/chat/completions`

Runs the public chat path through agent-group routing, session persistence, and the session runtime.

Important request fields:

- `messages`: required non-empty array
- `model`: optional alias for `provider_model` on the selected agent group
- `agent_group_id`: optional explicit agent-group id
- `thread_id`: optional thread selector, defaults to `default`
- `provider_model`: optional provider model override for the session config
- `stream`: optional boolean for SSE streaming

Important responses:

- `200`: OpenAI-compatible chat completion payload for non-streaming calls
- `400`: invalid JSON or invalid/missing `messages`
- `404`: selected agent group not found
- `503`: session runtime unavailable
- `504`: delivery verification timed out before an intact reply was confirmed

Non-streaming response shape:

```json
{
  "id": "chatcmpl-<session-id>",
  "object": "chat.completion",
  "created": 1767225600,
  "model": "<resolved-provider>/<resolved-model>",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

Streaming responses are server-sent events that emit OpenAI-style `choices[].delta.content` chunks followed by `[DONE]`.

Routing precedence:

- `agent_group_id` in the body
- `X-Agent-Group-Id` header
- implicit `default`

When `agent_group_id` is omitted, the chat route still resolves the selected agent group from the header or implicit `default`. `provider_model` overrides the underlying provider model for that selected agent group without changing the routing contract. The body `model` field is accepted as an alias for that same provider-model override.

## `POST /v1/agent-groups`

Creates an agent group.

Key fields:

- `id`, `name`: required
- `provider`: defaults to `auto`
- `thinking`: defaults to `medium`
- `permissions`: defaults to `{ "default": "auto" }`
- `config`: optional JSON object stored as raw config JSON

Returns `201` with the created row. Invalid payloads return `400`.

## `GET /v1/agent-groups`

Lists agent groups ordered by creation time and id.

Returns `200` with an array of agent-group objects. `permissions` and `config` are parsed back into JSON objects.

## `GET /v1/agent-groups/:id`

Returns one agent group.

- `200` on success
- `404` if missing

## `PUT /v1/agent-groups/:id`

Applies a partial update to an agent group.

- `200` on success
- `400` for invalid fields
- `404` if the row does not exist

## `DELETE /v1/agent-groups/:id`

Deletes an agent group when no dependent rows block removal.

- `204` on success
- `404` if missing
- `409` when dependent rows still exist

Successful deletion also stops tracked live containers for that agent group.

## `POST /v1/schedules`

Creates a persisted schedule.

Required fields:

- `agent_group_id`
- `cron_expr`
- `prompt`

Optional fields:

- `mode`
- `config`
- `enabled`

Returns `201` with the created schedule. Validation failures return `400`. Unknown agent groups return `404`.

## `GET /v1/schedules`

Lists schedules.

Returns `200` with the persisted schedule array.

## `GET /v1/schedules/:id`

Returns one schedule.

- `200` on success
- `404` if missing

## `PUT /v1/schedules/:id`

Updates a schedule.

- `200` on success
- `400` for invalid payloads
- `404` if missing

## `DELETE /v1/schedules/:id`

Deletes a schedule.

- `204` on success
- `404` if missing

## `POST /v1/schedules/:id/run`

Runs a schedule immediately through the registered runtime bindings.

Returns `200` with a mode-specific result payload when execution succeeds.
Returns `404` if the schedule is missing.
Returns `500` if the run fails or the run result cannot be recorded.

## `POST /v1/approvals`

Creates an approval request row.

## `GET /v1/approvals`

Lists approvals, optionally filtered by query parameters handled by the approvals store.

## `GET /v1/approvals/:id`

Returns a single approval.

## `POST /v1/approvals/:id/approve`

Marks a pending approval as approved.

## `POST /v1/approvals/:id/decline`

Marks a pending approval as declined.

Approval endpoints return `404` when the row is missing and `400` for invalid payloads or expired-state problems.

## `POST /v1/wiki`

Creates a wiki entry backed by a markdown file and synchronized search index.

Important fields:

- `slug`
- `title`
- `content`
- optional `tags`, `provenance`, `created_by`

Returns `201` with the persisted wiki record.

## `GET /v1/wiki`

Lists wiki entries or performs a search, depending on query parameters.

## `GET /v1/wiki/search`

Alias for wiki search.

## `GET /v1/wiki/:slug`

Returns one wiki entry.

## `PUT /v1/wiki/:slug`

Updates an existing wiki entry.

## `DELETE /v1/wiki/:slug`

Deletes a wiki entry.

Wiki routes use `400` for invalid payloads, `404` for missing entries, and `409` for duplicate slug conflicts.

## `GET /v1/workflows`

Returns:

- registered workflow definitions
- workflow instances

Optional query parameters:

- `name`
- `status`

Invalid status filters return `400`.

## `POST /v1/workflows`

Starts a workflow instance.

Required fields:

- `name`
- `input` object

Optional fields:

- `id`
- `agent_group_id`
- `thread_id`
- `session_id`

When `session_id` is omitted, the API defaults:

- `agent_group_id` to `default`
- `thread_id` to `workflow:<instance-id>`

Responses:

- `201` with `{ "instanceId": "..." }`
- `400` for invalid JSON or payload shape
- `404` if the workflow definition is unknown
- `409` for duplicate or invalid lifecycle conflicts
- `503` if the workflow runtime is not started

## `GET /v1/workflows/:instanceId`

Returns the public workflow status projection.

Response fields include:

- `instanceId`
- `name`
- `status`
- `output`
- `customStatus`
- `createdAt`
- `updatedAt`

## `POST /v1/workflows/:instanceId/signal`

Signals a running workflow.

Required body:

```json
{
  "eventName": "...",
  "data": {}
}
```

Returns `200` with `{ "signalled": true }`.

## `POST /v1/workflows/:instanceId/terminate`

Terminates a workflow.

Returns `200` with `{ "terminated": true }`.

## Internal Stream Relay Routes

These routes exist for internal streaming coordination and are not part of the main public product surface:

- `POST /internal/streams/:id/chunk`
- `POST /internal/streams/:id/complete`
- `POST /internal/streams/:id/error`
