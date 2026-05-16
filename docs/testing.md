# Testing

## Deterministic Verification

The main local verification path is deterministic and does not require live credentials.

Run these commands from the repo root:

```bash
bun run typecheck
bun test
bun run test:docker
bun run bench
bun run test:coverage
```

What each command covers:

- `bun run typecheck`
: TypeScript correctness across `src/`, `tests/`, and scripts.
- `bun test`
: Main deterministic unit and integration coverage.
- `bun run test:docker`
: Container-oriented proof tests under `tests/container` and `tests/container-agent`.
- `bun run bench`
: Performance bench-style tests under `tests/performance`.
- `bun run test:coverage`
: Bun coverage plus the repo coverage gate.

## Coverage Gate

`bun run test:coverage` does two things:

1. Runs Bun tests with LCOV output written under `coverage/`.
2. Runs `scripts/check-coverage.ts`.

The checker:

- reads `coverage/lcov.info`
- resolves `SF:` paths back to project files
- keeps only real files under `src/`
- calculates aggregate line coverage from `LF` and `LH`
- fails if `src/` line coverage drops below 90%

If the LCOV file is missing or malformed, the command fails instead of silently passing.

## Live Chat E2E

The repo also includes an opt-in local live smoke harness:

```bash
bun run test:e2e:live
```

By default this command skips and exits successfully.

Skip behavior:

- If `COVE_LIVE_E2E` is not set to `1`, the script prints a skip message and exits `0`.

To run the real live smoke test:

```bash
COVE_LIVE_E2E=1 GH_TOKEN="$(gh auth token)" COVE_LIVE_MODEL="github-copilot/gpt-4.1" bun run test:e2e:live
```

Optional override:

```bash
COVE_LIVE_E2E=1 COVE_LIVE_PROVIDER=openai COVE_LIVE_MODEL=openai/gpt-4.1 bun run test:e2e:live
```

The live harness:

- creates a temp `COVE_STATE_DIR`
- seeds a real agent group in the central SQLite database
- uses the configured provider-qualified live selector
- boots the real host runtime through `boot()`
- waits for a warm container to become ready
- sends a real `POST /v1/chat/completions` request
- checks for HTTP `200`
- validates the OpenAI-compatible response shape
- requires non-empty direct assistant content
- verifies that the session row and session artifacts were created
- shuts the runtime down and deletes temp state on success or failure

## Live E2E Prerequisites

The opted-in live run needs more than the deterministic suite.

Required:

- a working container runtime
- the configured container image available locally
- valid credentials for the selected live provider path, such as `GH_TOKEN` for `github-copilot/gpt-4.1`

Useful checks:

- the container runtime is reachable from your shell
- the expected image from `src/container/image.ts` already exists locally

If the default image is missing, the script prints the exact `docker build ...` command produced by the repo helper.

## Cost And Stability Caveats

The live smoke is intentionally not part of `bun test` or CI-style deterministic gating because it:

- uses real credentials
- can incur model cost
- depends on external model/provider availability
- can fail for environment reasons unrelated to the codebase

Use it to prove the end-to-end local product path, not as a fast feedback loop for every edit.

## Focused Development Loops

For faster iteration, run the narrowest useful test target.

Examples:

```bash
bun test tests/api/chat.test.ts
bun test tests/session/runtime.test.ts
bun test tests/live-e2e-chat.test.ts
```

This is especially useful when changing:

- routing or public API handlers
- session DB contracts
- container runtime startup or auth fallback logic
- the live E2E helper exports

## What Phase 12 Requires

Phase 12 is only fully closed when all of these have passed:

```bash
bun run typecheck
bun test
bun run test:docker
bun run bench
bun run test:coverage
bun run test:e2e:live
COVE_LIVE_E2E=1 GH_TOKEN="$(gh auth token)" COVE_LIVE_MODEL="github-copilot/gpt-4.1" bun run test:e2e:live
```

The first `test:e2e:live` run proves skip behavior.
The second proves the real local live path.
