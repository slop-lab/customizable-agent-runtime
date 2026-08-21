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

## DIM workflow

CAR uses DIM as development infrastructure, not as part of the runtime kernel.
DIM owns the persistent isolated workspace, nested containers, resource limits,
and Git promotion boundary. CAR owns agent semantics and runtime behavior.
All runtime interfaces must also work in a normal local checkout, container,
VM, or remote workspace without DIM environment variables or controller APIs.

Register the checked-out repository as the Project root (adjust URL and ref):

```bash
dim project create car --url /path/to/customizable-agent-runtime --ref main
dim workspace create car car-dev --cpus 4 --memory 8g --pids-limit 1024
dim workspace run car-dev codex
```

Available Project tasks are `codex`, `bash`, `check`, `test`, and `build`.
Project setup is idempotent and runs `pnpm install --frozen-lockfile` when a
lockfile exists, otherwise `pnpm install` during initial bootstrapping.

The development service uses a private rootless Docker daemon. Do not mount the
host Docker socket into the agent service. Add protected refs when this
repository starts carrying deployment authority or secret-bearing lifecycle
code.
