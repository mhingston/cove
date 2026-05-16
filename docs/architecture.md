# Architecture

## Overview

Cove runs as one host Bun process that owns the API server, the central SQLite state, the workflow runtime, the schedule loop, and the container sweep. Per-session agent execution happens in separate containerized runtimes that read from and write to session-local SQLite files.

At a high level:

- The host process boots shared services from `src/index.ts`.
- The central database lives at `${COVE_STATE_DIR}/cove.db`.
- Each session gets its own directory under `${COVE_STATE_DIR}/sessions/<agent-group-id>/<session-id>/`.
- Each session directory contains `inbound.db`, `outbound.db`, and working-context files.
- Long-lived workflows run in a host-owned Duroxide runtime backed by `workflows.db` plus a metadata database.
- Optional warm containers are pre-started so a live session can adopt an already-running runtime.

## Boot Lifecycle

`boot()` in `src/index.ts` is the top-level runtime entry point.

On startup it:

1. Opens the central database with foreign keys enabled.
2. Runs SQLite migrations from `src/db/migrate.ts`.
3. Cleans up orphaned labeled containers.
4. Starts the warm pool.
5. Starts the workflow runtime and binds PI workflow helpers.
6. Starts the scheduler.
7. Starts the container sweep.
8. Starts the HTTP API server.

Shutdown happens in reverse order through the cleanup stack created in `boot()`.

## State Layout

The state root defaults to `~/.cove` and can be overridden with `COVE_STATE_DIR`.

Important files and directories:

- `cove.db`: central application state such as agent groups, sessions, schedules, approvals, and wiki index data.
- `workflows.db`: durable workflow runtime state.
- `workflows.metadata.db`: workflow instance metadata owned by the host runtime.
- `sessions/<agent-group-id>/<session-id>/`: per-session state.
- `warm/<warm-session-id>/`: warm-pool session state.
- `wiki/`: markdown-backed wiki entries.
- `personas/<agent-group-id>/`: optional filesystem persona files such as `SOUL.md`.

## Session Contract

Routing happens in `src/router.ts`.

- Public chat and workflow calls resolve an agent group and thread id.
- Sessions are unique per non-null `(agent_group_id, thread_id)`.
- `src/session/manager.ts` ensures the session row exists and materializes the session directory.

Each session directory contains two SQLite files with a simple queue contract:

- `inbound.db`
: `messages_in` stores executable user turns at even sequence numbers, and `session_config` stores the effective runtime config.
- `outbound.db`
: `messages_out` stores assistant output at odd sequence numbers, and `processing_ack` tracks heartbeat plus last processed sequence numbers.

The host writes inbound work and polls `outbound.db` until a complete, gap-free response is verified.

## Host And Container Responsibilities

The host process is the system of record.

Host-owned responsibilities:

- HTTP routing and JSON validation
- agent-group, schedule, approval, workflow, and wiki persistence
- session routing and session directory setup
- workflow orchestration and lifecycle tracking
- container bookkeeping, restart, and sweep logic
- context assembly using persona, working transcript, and memory search

Container-owned responsibilities:

- reading session-local `session_config`
- processing new inbound user work
- producing assistant output into `messages_out`
- updating `processing_ack` heartbeat and progress
- running the real PI agent session and tool/approval hooks

## Warm Pool

`src/warm-pool.ts` maintains a bounded pool of pre-started containers.

- Warm entries live under `${COVE_STATE_DIR}/warm/`.
- Each warm session is seeded with a minimal `session_config` before the container starts.
- A warm entry becomes ready only after `processing_ack` appears in its `outbound.db`.
- When a live request needs a runtime, `src/session/runtime.ts` tries to adopt a ready warm container before falling back to a cold spawn.
- If adoption succeeds, the live session row is updated to the adopted session directory.
- After adoption, the persisted `COVE_SESSION_ID` becomes the authoritative logical session identity even though the adopted directory can still live under `warm/<warm-session-id>`.
- Runtime shutdown now stops any still-tracked session containers before warm-pool cleanup so adopted containers do not keep polling deleted session state.

Pool size is controlled by:

- `COVE_POOL_MIN`
- `COVE_POOL_MAX`

## Delivery Verification

`src/delivery.ts` is the integrity gate for non-streaming chat replies.

The host does not return the first visible assistant row immediately. It waits until:

- there is visible outbound data after the current baseline sequence,
- no sequence gaps remain,
- `processing_ack.last_out_seq` matches the newest visible outbound row.

If that does not happen within the configured polling window, the request fails with a delivery timeout.

## Persona, Working Context, And Memory

The runtime can inject context from several sources.

- `src/context/persona.ts` loads persona text from explicit config, filesystem persona files, or the agent-group `soul` column.
- `src/context/working.ts` stores the current working transcript in the session directory.
- `src/context/assembly.ts` builds the effective context in this order: persona, working context, up to three retrieved memories, then request messages.
- `src/knowledge/wiki.ts` stores wiki entries as markdown files and keeps a searchable SQLite index in sync.

## Approvals And Tool Policy

Tool policy is enforced inside the PI runtime.

- `src/control/policy.ts` defines default tool tiers and dynamic rules.
- `src/control/permissions.ts` exposes the permission bridge used by runtime hooks.
- Confirm-tier tool calls create approval rows and pause execution until the approvals API resolves them.

The default posture is conservative for mutating tools such as `bash` and `write`.

## Workflows

Workflows are still host-owned and do not move into session containers, but some workflow steps now execute through the routed session runtime.

- `src/workflows/runtime.ts` runs the Duroxide runtime and tracks workflow instances in the metadata database.
- `src/workflows/session-bindings.ts` keeps workflow orchestration on the host, but routes workflow `prompt`, `tool`, `llm`, and `skill` actions into the target session container by writing `workflow_action` metadata into the session queue and polling for a correlated `workflow_action_result`.
- `src/api/handlers/workflows.ts` exposes the public workflow API.

This means workflow definitions, lifecycle, waiting, signalling, rollback, and `sendMessage()` stay centralized on the host even when a workflow step needs a container-backed prompt, tool call, skill call, or LLM call.

## Container Sweep

`src/host-sweep.ts` watches active containers for stale heartbeats and stuck claims.

It can:

- restart a session when the container exits,
- restart or kill a session when the heartbeat exceeds the configured ceiling,
- restart or kill a session when work is stuck without observable progress.

The sweep relies on the tracked container map plus each session's `processing_ack` and inbound queue state.
