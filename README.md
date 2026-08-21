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

The current implementation is a deliberately small in-memory architecture
spike. It proves the package boundaries, a replaceable provider, a unified tool
dispatcher, stable IDs, records, and structured events. It does not yet claim
durable history or production readiness.

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
