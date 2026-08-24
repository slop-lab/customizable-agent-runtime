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
packages/plugin-gitea/ trusted read-only Gitea integration
packages/plugin-mcp/   bounded remote Streamable HTTP MCP tools
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

The daemon binds to `127.0.0.1:4317` by default. Open that address in a browser
to use the functional web client. It creates and selects durable sessions,
starts and cancels runs, polls the transcript, expands tool calls/results, and
inspects attempts, operations, provenance, and the latest context projection.
It deliberately uses plain HTML/CSS/JavaScript and has no UI framework or
polished interaction contract. The same page includes a functional adaptive
review-workflow panel for creating a repository/head plan, completing ordered
gates, recording risk evidence, changing the head, and inspecting merge
blockers and revision counts.

Every request must use an allowed `Host`, browser requests must use an allowed
`Origin`, and every `POST` must send `Content-Type: application/json`. Loopback
origins are allowed by default. A non-loopback `CAR_HOST` requires a
comma-separated exact-origin allowlist such as
`CAR_ALLOWED_ORIGINS=https://car.example.internal`; configure the reverse proxy
to preserve that host. Request bodies are capped at 128 KiB. This boundary is
defense in depth for the local API, not a substitute for authentication or TLS.

The same operations remain available through the initial HTTP API:

```bash
curl http://127.0.0.1:4317/v1/capabilities
curl http://127.0.0.1:4317/v1/plugins
curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:4317/v1/sessions
curl http://127.0.0.1:4317/v1/sessions
curl -X POST -H 'content-type: application/json' \
  -d '{"input":"Summarize this repository"}' \
  http://127.0.0.1:4317/v1/sessions/SESSION_ID/runs
curl http://127.0.0.1:4317/v1/runs/RUN_ID
curl http://127.0.0.1:4317/v1/usage
curl http://127.0.0.1:4317/v1/runs/RUN_ID/provenance
curl http://127.0.0.1:4317/v1/runs/RUN_ID/worker-execution-manifests
```

### Adaptive pull-request review flow

CAR can durably evaluate whether a project-specific review plan is locally
satisfied. The built-in adaptive flow requires protected-base
evidence, implementation, an opened pull request, automated checks, agent code
review, and a distinct human approval. Evidence is pinned to the current head.
Submitting `risk.detected` evidence can append a required review stage and
reopen its transitive downstream gates. Every accepted mutation advances an
append-only revision, and stale `expectedRevision` writes fail with HTTP 409.
Evidence and head changes also carry caller-scoped `externalEventId` values so
exact retries return the already committed result rather than duplicating it.

Create a workflow (the browser provides the same controls):

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"projectId":"car","repository":"dim/car","baseBranch":"main","headSha":"0123456789abcdef0123456789abcdef01234567"}' \
  http://127.0.0.1:4317/v1/review-workflows

curl http://127.0.0.1:4317/v1/review-workflows
curl http://127.0.0.1:4317/v1/review-workflows/WORKFLOW_ID
curl 'http://127.0.0.1:4317/v1/review-workflows/WORKFLOW_ID/history?limit=50'
```

Mutations use the returned `workflow.currentRevision`. Stage completion is
`POST /v1/review-workflows/{id}/stages/{stageId}/complete` with
`{"expectedRevision":N,"evidence":{"externalEventId":"...",...}}`. Additional normalized evidence uses
`POST /v1/review-workflows/{id}/evidence`; a head change uses
`POST /v1/review-workflows/{id}/head`. Current/list/mutation responses are
bounded projections with `historyCounts`; immutable audit data is read in
descending revision pages from `/history?limit=1..100&beforeRevision=N`.

The current HTTP API and browser are a local policy simulation: callers assert
Git-host, CI, agent, and human source labels themselves. Accordingly,
`mergeReadiness.ready` means the local graph is satisfied, while
`mergeReadiness.publishable` remains `false` until a future authenticated
adapter supplies attested evidence. A Git-host required check must consume only
the latter. The UI labels manual actions as assertions rather than approvals
from an authenticated authority.

The core contract is provider-neutral. `core.review.declarative` consumes typed
JSON-compatible stage configuration, so a future YAML adapter can compile into
it without making YAML authoritative. `core.review.adaptive` demonstrates
runtime revision in response to evidence. Fully trusted in-process plugins may
register additional namespaced providers during setup. `revise` receives an
explicit bounded chronological window as
`recentEvidence` (at most 100 current-head items, returned oldest-to-newest)
plus `evidenceWindow.{limit,total,truncated}` and `latestEvidence`. Providers
must carry durable derived policy forward in the plan rather than assuming the
entire evidence history is resident in memory. The registrar remains
pre-stable and provides no code isolation. Providers are pinned by `id@version`,
and multiple versions can coexist for existing durable workflows. Stage
definitions own their evidence type, accepted source kinds, and required
payload fields, all of which participate in the transitive gate hash. DIM and
Symphony adapters, Gitea PR
creation/status publication, branch-protection management, and authenticated
human identity are intentionally not part of this slice. Until a Git-host
adapter publishes readiness as a required check, the result does not by itself
prevent a remote merge.

Run the complete local lifecycle, including daemon restart and head
invalidation, with `just test-review-workflow`.

The current implementation is a durable kernel spike. It persists sessions,
runs, immutable run and worker-execution provenance manifests, operations,
model attempts, normalized context projections, provider request/event
artifacts, adaptive review plans/revisions/evidence/results, records, command
receipts, and an event outbox in SQLite. It
recovers abandoned work after restart and routes default `read`, `glob`,
`grep`, `edit`, `write`, `apply_patch`, `bash`, `git_status`, and `git_diff`
tools through a typed workspace worker. The older
`list`, `search`, and `shell` names remain available for pre-stable durable
session compatibility. Large successful tool output
is retained as an operation-owned artifact while only a bounded head/tail
projection and `artifact://` reference enter model context.
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
`GET /v1/runs/{id}/attempts`, `GET /v1/runs/{id}/provenance`, and the linked
context and artifact endpoints. The provenance response retains a redacted,
versioned structured manifest and its canonical SHA-256 digest. It identifies
the runtime/source revision, driver policy, provider/transport, context
projector, tool schema hashes, workspace, worker, and security/redaction
profile available when the run was accepted.
Runs that execute tools through the process backend also expose child-produced,
immutable execution manifests at
`GET /v1/runs/{id}/worker-execution-manifests`. Each manifest binds an opaque
renewable lease to the child Node/platform identity, environment key names,
resource limits, and supported request types without retaining environment
values or the host workspace path.
`GET /v1/artifacts/{id}/content` returns the persisted, redacted request or
semantic-event stream for local development inspection.

The default development worker remains in-process. Set
`CAR_WORKER_BACKEND=isolated-process` when starting the daemon to use the lazy
JSON-lines child-process backend. This validates serialization, cancellation,
lease renewal/expiry, crash recovery, and explicit environment projection, but
it is **not a security sandbox**: it shares the host user, kernel, filesystem
visibility available to that user, and inherited network policy.

### Trusted external plugins

The daemon can explicitly compose trusted, in-process plugins. No plugin is
enabled by default, and this pre-stable host does not scan directories, install
packages, or isolate plugin code. Plugin tools use the same dispatcher,
validation, middleware, cancellation, persistence, and provenance path as
built-in tools. `GET /v1/plugins` runs bounded health checks and returns active
plugin identity and health without configuration values.

The Gitea integration provides bounded, read-only repository and pull-request
lookup tools. Configure an opaque credential handle rather than a raw token in
plugin configuration:

```bash
export DIM_GIT_TOKEN=YOUR_GITEA_TOKEN
export CAR_PLUGINS=gitea
export CAR_GITEA_URL=http://127.0.0.1:3000
export CAR_GITEA_CREDENTIAL_HANDLE=env:DIM_GIT_TOKEN
just start

curl http://127.0.0.1:4317/v1/plugins
curl http://127.0.0.1:4317/v1/capabilities
```

The transport resolves `DIM_GIT_TOKEN` only when making a Gitea request. The
token is not included in the plugin manifest, model-visible tool results, or
run provenance. The two exposed tools are
`integration.gitea.repository.get` and `integration.gitea.pull.get`; there is
no generic HTTP escape hatch.

The MCP integration connects to one explicitly configured remote Streamable
HTTP server, discovers its tools during startup, and exposes only exact
allowlisted tools that declare `readOnlyHint: true`. It does not scan local
configuration, spawn stdio servers, fall back to legacy SSE, run OAuth flows,
or expose resources and prompts. For example:

```bash
export MCP_API_TOKEN=YOUR_REMOTE_TOKEN
export CAR_PLUGINS=mcp
export CAR_MCP_SERVER_ID=issues
export CAR_MCP_URL=https://mcp.example.test/rpc
export CAR_MCP_ALLOWED_TOOLS=issues.get,issues.search
export CAR_MCP_CREDENTIAL_HANDLE=env:MCP_API_TOKEN
just start
```

The resulting model-visible names are deterministic, such as
`integration.mcp.issues.issues-get`; calls retain the server's original raw
tool name. Startup fails closed for missing allowlist entries, duplicate or
normalizing-colliding names, absent read-only hints, excessive catalog pages,
or excessive schema bytes. Calls carry cancellation and bounded timeouts;
binary content is reduced to metadata, and oversized projected results fail
instead of entering model context. The credential value is resolved before
each HTTP request and only its handle enters provenance. The default bounds
are 8 catalog pages, 32 listed tools, 64 KiB of selected schemas, a 10-second
connection timeout, a 30-second call timeout, and 64 KiB of projected output;
the corresponding `CAR_MCP_*` overrides are listed in `.env.example`.

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

### Context projection and pruning

The default runtime applies a provider-neutral context transform before each
provider request. Durable records and artifacts remain unchanged. Once 20
successful, non-protected tool exchanges are visible, the transform replaces
the oldest ten tool-result outputs with a fixed tombstone and keeps the newest
ten intact. It advances in batches of ten rather than changing the old prefix
on every call. Tool call IDs, names, inputs, result pairing, errors, and durable
artifact references are preserved.

Every context projection records transform identity/version/configuration,
status, input/output hashes, and per-result decisions. A transform failure is
persisted as a failed projection and model attempt before the run fails. The
immutable run provenance records the configured transform set. The web
inspector exposes this data.
Configure or disable the default policy before starting the daemon:

```bash
export CAR_CONTEXT_TOOL_RESULT_PRUNING=on # or off
export CAR_CONTEXT_PRUNE_TRIGGER=20
export CAR_CONTEXT_RETAIN_TOOL_RESULTS=10
export CAR_CONTEXT_PRUNE_BATCH=10
export CAR_CONTEXT_PROTECTED_TOOLS=skill,todo,plan
```

This deterministic payload pruning is separate from future model-generated
summarization and provider-specific raw-request hooks.

The default model is the verified paid route `google/gemma-4-26b-a4b-it`. Set
`CAR_OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free` to try the free route;
free endpoint availability is not guaranteed. HTTP 429 responses are terminal
for a run and are never automatically retried. OpenRouter uses Chat Completions
SSE; every decoded chunk is retained before text and indexed tool-call deltas
are assembled. Redacted replay fixtures cover success, a tool loop, 429, 5xx,
malformed arguments, and cancellation without requiring credentials in CI.

An external ingress is not required for the local web workflow. DIM can expose
the daemon and its same-origin web client with
`dim external-url request --ingress NAME`; the ingress itself must first be
configured by the DIM host administrator.

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
