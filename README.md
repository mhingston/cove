# Cove

Cove is a local-first runtime for developers who want durable AI agent sessions behind a simple HTTP API. It exposes an OpenAI-style chat surface, but each conversation is backed by a real long-lived container session with persistent thread state, approvals, schedules, workflows, and searchable wiki memory.

It is built for a single operator on a local machine. The host process owns the API, SQLite state, scheduling, and workflow orchestration; agent execution happens in isolated per-session containers.

## Who It's For

- Developers integrating a persistent agent runtime into local tools or services.
- Operators who want approvals, schedules, workflows, and recovery around the same agent.
- People who want inspectable local state in SQLite and the filesystem instead of opaque hosted memory.
- Anyone prototyping a durable agent product locally before wrapping it in a larger app.

If you want to get a local instance running, jump straight to [Quick Start](#quick-start).

## Why You'd Use It

- Keep thread state and working context across requests instead of treating every prompt as stateless.
- Expose agents through a simple HTTP surface while keeping runtime state inspectable in SQLite and the filesystem.
- Add approvals, recurring jobs, workflows, wiki-backed memory, and recovery around the same runtime.
- Prove the real path locally with deterministic tests plus an opt-in live E2E smoke.

## Core Capabilities

- OpenAI-style chat API at `POST /v1/chat/completions`, with non-streaming replies and SSE streaming.
- Agent groups as durable runtime profiles with provider, model, thinking level, permissions, persona, workspace, and runtime-prep config.
- Persistent threads keyed by `agent_group_id` plus `thread_id`.
- Isolated per-session container execution, with a host process that stays authoritative for routing and state.
- Warm-pool startup and warm-session adoption for faster live requests.
- Delivery verification for non-streaming replies so Cove only returns a complete, gap-free assistant response.
- Approval gates for confirm-tier tools.
- Context assembly from persona text, working transcript, and wiki-backed memory retrieval.
- Markdown-backed wiki storage with a synchronized SQLite search index.
- Persisted schedules with `agent`, `notification`, `script`, `hybrid`, and `workflow` modes.
- Host-owned durable workflows with start, status, signal, terminate, and rollback support.
- Heartbeat-based runtime sweep logic that can restart or kill stuck containers.
- Built-in provider auth passthrough for common API keys, GitHub Copilot auth, AWS and GCP credentials, plus custom allowlist-based passthrough config.

Key integrations:

- [pi-duroxide](https://github.com/mhingston/pi-duroxide): the Pi-facing workflow layer Cove uses to bind durable workflows back into agent turns, tools, and messages.
- [pi-onecli-extension](https://pi.dev/packages/pi-onecli-extension): the Pi extension Cove can load for inherited OneCLI gateway auth when that path is available in the runtime environment.

## Quick Start

### Prerequisites

- Bun
- A reachable container runtime for live agent sessions. Cove uses `docker` by default, but you can override that with `COVE_CONTAINER_RUNTIME_BIN`.
- A built agent image. `sh container/build.sh` builds the default image Cove expects.
- Valid provider credentials, such as `GH_TOKEN="$(gh auth token)"` or `OPENAI_API_KEY=...`.

### 1. Install dependencies and build the image

```bash
bun install
sh container/build.sh
```

If you use Podman instead of Docker:

```bash
COVE_CONTAINER_RUNTIME_BIN=podman sh container/build.sh
```

### 2. Export provider credentials

GitHub Copilot path:

```bash
export GH_TOKEN="$(gh auth token)"
```

OpenAI path:

```bash
export OPENAI_API_KEY="your-api-key"
```

### 3. Start Cove

```bash
bun run src/index.ts
```

The API binds to `127.0.0.1` and uses port `4111` by default. Set `PORT` or `COVE_PORT` to change the port.

The server can start and serve `GET /healthz` even if the container runtime is unavailable, but chat, schedules that execute code, and other live session features need a working container runtime.

### 4. Check health

```bash
curl http://127.0.0.1:4111/healthz
```

Expected response:

```json
{"ok":true}
```

### 5. Create an agent group

```bash
curl -sS -X POST http://127.0.0.1:4111/v1/agent-groups \
  -H "Content-Type: application/json" \
  -d '{
    "id": "copilot",
    "name": "Copilot",
    "provider": "github-copilot",
    "model": "gpt-4.1",
    "thinking": "medium",
    "permissions": { "default": "auto" }
  }'
```

For OpenAI, the same shape works with `"provider": "openai"` and a model such as `"gpt-4.1"`.

### 6. Send a chat request

```bash
curl -sS -X POST http://127.0.0.1:4111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "agent_group_id": "copilot",
    "thread_id": "demo",
    "messages": [
      { "role": "user", "content": "Reply in one sentence: what is Cove?" }
    ]
  }'
```

Reuse the same `thread_id` to continue the same durable conversation.

### 7. Stream tokens instead of waiting for the full reply

```bash
curl -N -X POST http://127.0.0.1:4111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "agent_group_id": "copilot",
    "thread_id": "demo-stream",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Count from one to three." }
    ]
  }'
```

## Common First Tasks

After the initial quick start, the usual next steps are:

1. Create an agent group for the provider and model you want to use.
2. Send a chat request with an explicit `agent_group_id` and `thread_id`.
3. Reuse the same `thread_id` to continue the durable session.
4. Inspect local state under `~/.cove` or `COVE_STATE_DIR`.
5. Run the live smoke test once your container runtime and provider credentials are working.

Useful places to inspect:

- `~/.cove/cove.db` for central application state
- `~/.cove/sessions/<agent-group-id>/<session-id>/` for per-session files
- `~/.cove/wiki/` for markdown-backed wiki entries
- `~/.cove/workflows.db` for workflow runtime state

## How Routing Works

- `agent_group_id` selects the public runtime profile. Use it explicitly in client requests.
- `thread_id` selects the durable thread inside that agent group. If omitted, Cove uses `default`.
- If `agent_group_id` is omitted, Cove falls back to `X-Agent-Group-Id`, then `default`.
- `provider_model` can override the underlying provider model for the selected agent group on a single chat request.
- `model` is also accepted on the chat route as an alias for that provider-model override.
- `GET /v1/models` lists agent groups as OpenAI-style models for discovery, but explicit `agent_group_id` is the clearest way to route chat traffic.

## API Overview

- `GET /healthz`: fixed health contract.
- `GET /v1/models`: list agent groups as OpenAI-style models.
- `POST /v1/chat/completions`: persistent chat, with optional `stream: true`.
- `POST`, `GET`, `PUT`, `DELETE /v1/agent-groups`: manage agent runtime profiles.
- `POST`, `GET`, `PUT`, `DELETE /v1/schedules`: manage persisted schedules and run them immediately.
- `POST`, `GET /v1/approvals` plus approve and decline endpoints: resolve confirm-tier tool requests.
- `POST`, `GET`, `PUT`, `DELETE /v1/wiki`: manage wiki entries and search.
- `GET`, `POST`, and instance routes under `/v1/workflows`: start, inspect, signal, and terminate workflows.

See `docs/api.md` for the full reference.

## How It Runs

- One host Bun process runs the API server, central SQLite databases, scheduler, a Duroxide-backed workflow runtime, and the container sweep.
- Each live session gets its own directory under `~/.cove` by default, or under `COVE_STATE_DIR` if you override it.
- Each session directory contains `inbound.db`, `outbound.db`, and working-context files.
- Warm containers live under `warm/<warm-session-id>/` and can be adopted by live sessions.
- The host remains the system of record. Containers do the per-session agent execution.

Workflow implementation note:

- Cove runs durable workflows on the host, not inside session containers.
- The runtime is built on Duroxide and exposed through Cove's workflow API under `/v1/workflows`.
- Pi-facing workflow calls are bound through `pi-duroxide` so a workflow step can call back into routed agent behavior when needed.

Important state locations:

- `~/.cove/cove.db`: central app state.
- `~/.cove/workflows.db`: workflow runtime state.
- `~/.cove/workflows.metadata.db`: workflow metadata.
- `~/.cove/sessions/<agent-group-id>/<session-id>/`: per-session state.
- `~/.cove/warm/<warm-session-id>/`: warm-pool state.
- `~/.cove/wiki/`: markdown-backed wiki entries.

## Agent Groups, Persona, And Context

An agent group is Cove's public runtime profile. It can carry:

- a provider and default model
- a thinking level
- a workspace mount
- tool permissions
- persona text through the `soul` field or filesystem persona files
- runtime-prep config through `config`

At request time, Cove assembles context in this order:

- persona
- working transcript
- up to three retrieved wiki memories
- request messages

## Runtime Prep And Auth

The `config` field on an agent group supports:

- `api_key`
- `credential_profile`
- `extra_env`
- `provider_env_passthrough`
- `provider_file_env_passthrough`
- MCP-related keys such as `mcp`, `mcp_config`, `mcpConfig`, `mcpServers`, `imports`, and `settings`

Built-in provider passthrough already covers common auth paths such as:

- `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `CLOUDFLARE_API_KEY`
- `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `AWS_WEB_IDENTITY_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`
- mounted credential directories such as `~/.aws` and `~/.config/gcloud`

Custom provider passthrough example:

```json
{
  "extra_env": {
    "FEATURE_FLAG": "enabled"
  },
  "provider_env_passthrough": [
    { "name": "CUSTOM_TOKEN", "required": true }
  ],
  "provider_file_env_passthrough": [
    { "name": "CUSTOM_CRED_FILE", "kind": "file", "required": true }
  ]
}
```

OneCLI integration:

- If `ONECLI_AGENT_NAME` and `ONECLI_URL` are present, Cove can inherit OneCLI gateway auth unless you disable it with `COVE_ONECLI_AUTH=0`.
- In that mode, Cove prefers inherited gateway auth for supported provider paths instead of persisting a raw API key into the session config.
- The container runtime only forwards an allowlisted subset of OneCLI gateway environment variables, so unrelated host secrets are not passed through accidentally.
- Cove also loads [`pi-onecli-extension`](https://pi.dev/packages/pi-onecli-extension) for inherited OneCLI gateway runs when the extension is available in the runtime environment.

## Schedules, Workflows, And Approvals

- Schedules are persisted cron jobs stored in the central database.
- `agent` schedules run a prompt through a routed Cove session.
- `notification` schedules log the configured prompt.
- `script` schedules run `sh -lc` inside the agent container image.
- `hybrid` schedules run the agent path and return a notification-style marker.
- `workflow` schedules start a registered workflow instance.
- Confirm-tier tool calls create approval rows and pause until an approval API decision is recorded.

Workflow notes:

- Workflows are durable and host-owned, so they survive process restarts through persisted runtime state in `workflows.db` and `workflows.metadata.db`.
- The public workflow surface is the `/v1/workflows` API, which supports start, list, get, signal, and terminate operations.
- Workflow schedules use the same runtime, so recurring jobs can launch durable multi-step flows instead of only one-shot prompts.

## Verification

Cove includes a deterministic local test suite plus an opt-in live chat E2E path.

Deterministic verification:

```bash
bun run typecheck
bun test
bun run test:docker
bun run bench
bun run test:coverage
```

Opt-in live smoke:

```bash
bun run test:e2e:live
COVE_LIVE_E2E=1 GH_TOKEN="$(gh auth token)" COVE_LIVE_MODEL="github-copilot/gpt-4.1" bun run test:e2e:live
```

The first command proves skip behavior. The second runs a real local end-to-end chat against a live provider path.

See [the testing guide](docs/testing.md) for the full testing guide.

## Key Environment Variables

- `COVE_STATE_DIR`: override the state root. Default is `~/.cove`.
- `PORT` or `COVE_PORT`: API port. Default is `4111`.
- `COVE_CONTAINER_RUNTIME_BIN`: container runtime executable. Default is `docker`.
- `COVE_POOL_MIN` and `COVE_POOL_MAX`: warm-pool size.
- `COVE_SWEEP_INTERVAL`: host sweep interval in milliseconds.
- `COVE_IMAGE_NAME`: agent image name that Cove will run.

## Further Reading

- [Architecture](docs/architecture.md): runtime design, state layout, warm pool, and delivery verification.
- [API Reference](docs/api.md): route-by-route reference.
- [Testing](docs/testing.md): deterministic verification, coverage gate, and live E2E details.
