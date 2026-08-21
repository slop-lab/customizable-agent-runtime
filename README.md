# Customizable Agent Runtime

Customizable Agent Runtime (`car`) is an experimental, API-first runtime for
building and studying coding agents. It owns stable identity, run lifecycle,
model invocation, tool dispatch, records, and events while leaving agent-loop
semantics and product policy to replaceable modules.

The project is deliberately pre-stable. Internal interfaces may change as the
first vertical slice validates its extension seams.

## Repository layout

This is one repository managed as a pnpm workspace. Package boundaries make
dependencies explicit without committing the project to multiple repositories.

```text
apps/daemon/          reference network host
packages/core/        embeddable runtime kernel and contracts
packages/defaults/    default driver, provider, and tool composition
docs/                 architecture decisions and development notes
.dim/                 DIM Project lifecycle
```

Dependencies point inward: `daemon -> defaults -> core`. The core does not
depend on a transport, database, provider SDK, or UI framework.

## Development

Requirements are Node.js 24 or 26 and pnpm 10.13.1. The repository pins a
recommended toolchain through mise and provides common commands through just.

```bash
mise install
just install
just verify
just start
```

Direct `pnpm` commands remain supported; `just` is only a convenience layer.

The daemon binds to `127.0.0.1:4317` by default. Try the initial API:

```bash
curl http://127.0.0.1:4317/v1/capabilities
curl -X POST http://127.0.0.1:4317/v1/sessions
curl http://127.0.0.1:4317/v1/sessions
curl http://127.0.0.1:4317/v1/usage
```

The current implementation is a durable kernel spike. It persists sessions,
runs, operations, model attempts, normalized context projections, provider
request/event artifacts, records, command receipts, and an event outbox in
SQLite. It recovers abandoned work after restart and routes default read,
directory-listing, regex-search, full-file write, unified-diff patch, shell, and
Git-status tools through a typed workspace worker.
A fake provider supports deterministic tests. OpenRouter Chat Completions and
Google Interactions adapters support real model-tool-model loops and preserve
each decoded SSE semantic event. It does not claim production readiness.

### Google live smoke test

Copy `.env.example` to `.env`, set `TEMPORARY_GEMINI_API_KEY`, then run:

```bash
just test-live-google
```

The smoke test requires the model to read this repository's `package.json`,
checks that two successful model attempts and the tool records were persisted,
and expects the final answer `@car/workspace`. The key is resolved only by the
HTTP transport and is excluded from request and event artifacts.

Operators can inspect a run through `GET /v1/runs/{id}/operations`,
`GET /v1/runs/{id}/attempts`, and the linked context and artifact endpoints.
`GET /v1/artifacts/{id}/content` returns the persisted, redacted request or
semantic-event stream for local development inspection.

Session/run summaries and normalized provider usage are available without
discarding the provider-native usage object:

```bash
curl http://127.0.0.1:4317/v1/sessions
curl http://127.0.0.1:4317/v1/sessions/SESSION_ID/runs
just usage
just usage --session SESSION_ID --json
```

`just usage` is a client of the daemon API, not a direct SQLite reader. Only one
writer may own `.car/runtime.sqlite`, so stop `just chat`, start `just start`,
and then use the standalone command. Inside chat, `/usage` inspects the active
session directly. Aggregates report per-field token and provider-reported cost
coverage so missing values remain distinguishable from numeric zero.

### Interactive agent test

Set `OPENROUTER_API_KEY` in `.env`, then start a multi-turn interactive session:

```bash
just chat
```

Enter one or more lines and use `/send` to make exactly one model run. `/show`
previews the pending prompt and `/cancel` discards it. This explicit send step
prevents pasted multiline prompts from becoming multiple requests. Each sent
prompt uses the same session, so subsequent turns receive its persisted
context. The terminal shows assistant replies, tool calls, run IDs, model-
request counts, retries, and failures. `/sessions`, `/runs`, and `/resume`
continue a durable session after restart; `just chat --resume SESSION_ID`
selects one at startup. `/new` creates a new session and `/usage` summarizes the
selected session. Use `/id` to print the full session ID and `/exit` to quit.
Ctrl-C during a run requests durable cancellation; Ctrl-C while idle exits.
Complete records, attempts, normalized contexts and usage, and provider
artifacts remain under `.car/` and are available through the daemon inspection
endpoints.

The default model is the verified paid route `google/gemma-4-26b-a4b-it`. Set
`CAR_OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free` to try the free route;
free endpoint availability is not guaranteed. HTTP 429 responses are terminal
for a run and are never automatically retried. OpenRouter uses Chat Completions
SSE; every decoded chunk is retained before text and indexed tool-call deltas
are assembled. Redacted replay fixtures cover success, a tool loop, 429, 5xx,
malformed arguments, and cancellation without requiring credentials in CI.

The daemon remains available through `just start`, but an external ingress is
not required for this local inspection workflow. If a UI is added later, DIM
can expose its container port with `dim external-url request --ingress NAME`;
the ingress itself must first be configured by the DIM host administrator.

## Developing with DIM

The repository follows DIM's single-repository Project contract. Register the
official GitHub repository as the DIM Project's external source, then create a
bounded workspace:

```bash
dim project create car \
  --url https://github.com/slop-lab/customizable-agent-runtime.git \
  --ref main --apply-repos
dim workspace create car car-dev --cpus 4 --memory 8g --pids-limit 1024
dim workspace run car-dev codex
dim workspace run car-dev check
```

Inside a workspace, `origin` is the Project-scoped DIM Gitea repository. The
Project's recorded external source remains the official GitHub repository;
host-side `dim repo fetch` and `dim repo push` synchronize explicitly between
the two boundaries.

`.dim/setup.sh` starts an unprivileged development container with a private
rootless Docker daemon. The agent receives neither the host Docker socket nor
the original DIM controller socket. See [DIM development](docs/development.md).

## Design status

The complete product and architecture requirements live in
[docs/requirements.md](docs/requirements.md); no local-only file is required.
Reviewable decisions live under [docs/adr](docs/adr/README.md). The unresolved
choices with the largest architectural impact are listed in
[ADR 0001](docs/adr/0001-initial-architecture.md#remaining-high-impact-decisions).
