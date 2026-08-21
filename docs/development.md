# Development

## Local workflow

Install the pinned toolchain and run all checks from the repository root:

```bash
mise install
just install
just verify
```

The equivalent direct commands are `pnpm install --frozen-lockfile`, `pnpm
check`, `pnpm test`, and `pnpm build`. Dependency and toolchain updates must be
explicit and reviewed.

The daemon stores its SQLite state in `.car/runtime.sqlite` by default. Set
`CAR_DATA_DIR` to use a separate data directory for tests or parallel manual
experiments. Only one daemon writer may open a data directory at a time.

## DIM workflow

CAR uses DIM as development infrastructure, not as part of the runtime kernel.
DIM owns the persistent isolated workspace, nested containers, resource limits,
and Git promotion boundary. CAR owns agent semantics and runtime behavior.
All runtime interfaces must also work in a normal local checkout, container,
VM, or remote workspace without DIM environment variables or controller APIs.

Register the official GitHub repository as the Project root:

```bash
dim project create car \
  --url https://github.com/slop-lab/customizable-agent-runtime.git \
  --ref main --apply-repos
dim workspace create car car-dev --cpus 4 --memory 8g --pids-limit 1024
dim workspace run car-dev codex
```

Workspace clones use DIM-managed Gitea as `origin`; do not replace it with the
GitHub URL. From the DIM host, import official changes under the managed
`upstream/*` namespace and publish reviewed refs back to GitHub explicitly:

```bash
dim repo fetch car car
dim repo push car car refs/heads/main:refs/heads/main
```

Available Project tasks are `codex`, `bash`, `check`, `test`, and `build`.
Project setup is idempotent and runs `pnpm install --frozen-lockfile` when a
lockfile exists, otherwise `pnpm install` during initial bootstrapping.

The development service uses a private rootless Docker daemon. Do not mount the
host Docker socket into the agent service. Add protected refs when this
repository starts carrying deployment authority or secret-bearing lifecycle
code.
