# Modules and feature placement

## Provider subsystem

A provider profile selects adapter, endpoint, model or alias, transport,
credential-handle reference, request defaults, timeouts, retries, rate limits,
cost metadata, and capability overrides. Adapters translate runtime content,
tools, stream chunks, errors, and provider-native data. Transports own
connectivity, authentication, proxying, network retry, and streaming.

Capabilities include streaming, tools and parallel tools, structured output,
reasoning, image/file input, prompt caching, server-side history, continuation,
cancellation, token usage, cost, and context limits. Credential deployment may
use direct environment keys, a keychain, external command, broker, custom
endpoint, or short-lived token; credential isolation is a profile, not a
universal claim.

The common provider interface contains no login, refresh, token, API-key, or
account concepts. It advertises capabilities and accepts a normalized request
plus an opaque transport context. A deployment-specific transport resolves any
credential handle without exposing raw credentials to the driver, context
pipeline, records, plugin API, or inspector.

Capabilities are versioned values with optional constraints, not a growing set
of mandatory booleans. They cover input modalities, streaming granularity,
tool-call forms and concurrency, structured output dialects, reasoning,
server-side state, caching, cancellation, continuation, context/output limits,
usage and cost reporting, error/retry semantics, and provider-native extension
namespaces. Drivers negotiate requirements before a run and fail explicitly or
select a documented fallback; adapters must not silently emulate unsupported
semantics.

## Agent drivers

A driver decides context inclusion, model-call timing, tool-loop continuation,
stop semantics, in-flight input handling, token/error recovery, and when to
return control to a workflow. The default coding driver implements input,
context, streaming model calls, zero or more tool calls and results, repetition,
and completion/failure/cancellation.

Drivers advertise namespaced actions and schemas rather than forcing every UI
to display `steer`. In-flight input may cancel and rebuild, wait for a tool,
enter the next model call, schedule a later run, queue only, or be rejected.
Approval and questions build on general operation suspension and typed external
responses.

## Tools

Definitions carry stable qualified ID, description, input/output schemas,
side-effect class, streaming/cancellation support, timeout, required
capabilities, executor, provenance, and version. Results may contain text,
structured JSON, tables, diffs, file/image/diagnostic/progress/log/artifact
references, or interactive resources.

Middleware can allow, replace arguments, deny, suspend, substitute without
execution, or redirect. Redirected calls re-enter validation and policy.
Executors may be local, SSH, container, VM, browser, device, external API, MCP,
cache, or simulator. Execution context explicitly carries workspace, cwd,
environment, actor, run, permission/sandbox profile, credential handles,
cancellation, and deadline.

Long output is preserved as an artifact and projected into bounded model
content. Clients page through the original and projectors vary by output type;
one fixed head/tail truncation algorithm is insufficient. Default coding tools
include read, list, search, patch/edit, write, shell, process status, artifact
read, and optionally Git status/diff. PTY, LSP, browser, web, database, cloud,
and devices are separate modules.

## Progressive plugin model

The implemented first slice is deliberately narrower than the target model
below. A trusted host receives an explicit list of in-process plugins, validates
versioned manifests and dependency graphs, and allows setup-time registration
of tools and tool middleware only. Setup/start are sequential in deterministic
dependency order, cleanup is reverse-order, and health checks are bounded and
inspectable. There is no scanning, dynamic import/install, hot reload, module
state, event subscription, provider/context registration, or compatibility
promise yet. The separate `@car/plugin-gitea` package exercises this seam with
two read-only tools and a credential-resolving HTTP transport.

Extension levels are configuration; additive tools/providers/context/events/API
actions; middleware; strategy replacement; out-of-process integration; and
source modification. Initial semi-public seams are tool/provider registration,
events, context contributors, tool middleware, namespaced module state, and
namespaced actions. Driver replacement may remain internal until validated.

Every in-process plugin is fully trusted. It can access runtime memory and
control-plane authority, and tool sandboxing does not sandbox plugin code. It
does not receive workspace filesystem capability through the current registrar;
workspace I/O tools still use worker capabilities. A future restricted plugin
requires an out-of-process or WASM boundary and a different contract. The
longer-term lifecycle covers discovery, config validation, initialization,
registration, start, health, stop, state migration, and eventual reload; daemon
restart is acceptable initially.

Ordering must be deterministic through one documented priority/dependency rule.
Diagnose duplicate tool/provider IDs, cycles, protocol mismatches, and competing
state owners. Hook-specific failure policy may fail open, fail closed, disable a
module, fail a run, or retry. Security policy defaults differ from telemetry.
Module state provides namespace, schema version, migration, transactions,
revision/CAS, events, and export policy.

## Higher-level features

- Skills combine context, tools, workflow, metadata, lazy discovery,
  activation, references, permissions, version, and provenance. `SKILL.md` is a
  compatibility module concern, not a kernel format.
- Memory combines scoped module state, retrieval, context contribution,
  optional writes, provenance, and confidence; it is not conversation history.
- Knowledge connectors expose tools, resources, context, subscriptions, or
  indexes and record source, fetch time, version, query, relevance, access
  policy, and citations.
- Worktrees belong to a workspace provider/workflow. Core uses opaque workspace
  handles and does not bind one worktree to one session.
- Subagents are child runs with parent/correlation, scoped context and tools,
  workspace selection, cancellation propagation, and result artifacts.
  Orchestration adds task graphs, leases, actors, durable mailboxes,
  concurrency, routing, recovery, and review gates. Terminal panes are views.
- Workflow continuation schedules an explicit next run from typed module state;
  stop hooks, synthetic “continue” user messages, and polled `active` files are
  not schedulers.
- Security composes allow/deny, command policy, approval, path/network limits,
  secret handles, executor restrictions, containers, remotes, and brokers. Each
  profile states trust in runtime, plugins, tool processes, workspace code,
  endpoint, and credential location.
- MCP is an adapter for tools, resources, prompts, elicitation, progress, and
  cancellation; it does not constrain CAR's internal model.
- Git hosts, issue trackers, chat, docs, monitoring, databases, artifact stores,
  CI, secret managers, calendars, and notifications are integrations.

## API and clients

The canonical remote transport is WebSocket JSON-RPC 2.0. It must support
request/response commands, server notifications, long operations, cancellation,
reconnect, snapshots, artifact streaming, capability discovery, and module
actions. Base objects include runtime, module, provider profile, session,
branch, run, operation, record, artifact, workspace reference, module state
projection, capabilities, and action schemas.

Actions are namespaced, for example `driver.coding/interrupt`,
`workflow.review/approve-stage`, or `workspace.git-worktree/create`. Events are
structured record, run, operation, model/tool delta, artifact, module
projection, and action-availability changes. Durable snapshots recover final
state if transient deltas are lost. Clients reconnect from a sequence/cursor
across refreshes, tunnel loss, sleep, network change, and daemon restart.

The base API and modules are versioned and capability-discovered. Unknown
records/actions get a generic structured or artifact fallback. Default remote
deployment is localhost plus SSH forwarding; later options include private
networks, reverse proxies, static tokens, OIDC, and client certificates.

The web UI is optional and uses only the API. It may show sessions, runs,
conversation, streams, tools, diffs, artifacts, context/final-request
inspectors, configuration, cancellation, actions, files/editor/PTY, background
operations, approvals, branches, usage, and cost. UI extension progresses from
generic renderers and forms to metadata panels and separate clients before any
arbitrary frontend plugin ABI. A CLI, if added, focuses on serve/status/doctor
and is not the stable automation protocol.

## Feature ownership summary

| Capability | Primary owner | Required foundation |
| --- | --- | --- |
| Sessions, history, branches | Core/history module | Identity, records, persistence |
| Model streaming and cancellation | Core provider layer | Operations, events |
| Tool-call loop and retry | Driver/provider policy | Provider, dispatcher, attempts |
| Instructions and compaction | Context modules | Visibility, transforms |
| Shell and file operations | Default tool modules | Dispatcher, executor, workspace |
| PTY and background processes | Resource modules | Long-lived operations/resources |
| MCP, LSP, browser, web search | Protocol/tool modules | Registry, resources, artifacts |
| Approval and permissions | Policy/UI modules | Suspension, middleware |
| Sandbox and secret broker | Execution/security modules | Executors, auth transports |
| Skills and repository rules | Compatibility modules | Context/tool registration |
| Plans, todo, continuation | Workflow modules | Typed module state, scheduler |
| Memory and knowledge | Retrieval modules | State, context sources, citations |
| Subagents and parallel teams | Orchestration modules | Child runs, leases, correlation |
| Worktrees and checkpoints | Workspace/history modules | Opaque workspace, snapshots |
| Scheduling and notifications | Scheduler/event consumers | Run creation, durable events |
| Web, IDE, collaboration | Client/integration packages | Versioned API, actor identity |
| Export, replay, evals | History/testing modules | Records, artifacts, manifests |
| Cost and telemetry | Observability modules | Usage, structured events |
