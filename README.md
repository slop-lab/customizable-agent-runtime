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
```

The current implementation is a durable kernel spike. It persists sessions,
runs, operations, model attempts, normalized context projections, provider
request/event artifacts, records, command receipts, and an event outbox in
SQLite. It recovers abandoned work after restart and routes default read and
shell tools through a typed workspace worker. A fake provider supports
deterministic tests, while the Google Interactions adapter supports a real
stateless model-tool-model loop. It does not claim production readiness.

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

### Interactive agent test

With the same `.env`, start a multi-turn interactive session:

```bash
just chat
```

Each prompt runs against the same session, so subsequent turns receive its
persisted context. The terminal shows assistant replies, tool calls, run IDs,
and failures. Use `/id` to print the session ID and `/exit` to quit. Complete
records, attempts, normalized contexts, and provider artifacts remain under
`.car/` and are available through the daemon inspection endpoints.

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
