# MVP and implementation roadmap

## MVP requirements

The MVP prioritizes one complete vertical slice over a plugin ecosystem.

### Must

- Embeddable core and long-running daemon.
- Stable session, branch, run, operation, and record identities.
- SQLite-backed durable history, operation lifecycle/cancellation, structured
  events, artifact storage, and namespaced module state.
- Provider adapter and transport/auth contracts, streaming, tools, custom
  endpoint, fake provider, capabilities, and final-request inspection.
- A capability-driven provider contract that contains no authentication
  concerns, plus a separately injected transport and opaque credential handle.
- Default coding loop through context, model, tool calls/results, repetition,
  and terminal state.
- Unified dispatcher, schema validation, middleware, result substitution, local
  executor, read/search/edit/shell, timeout/cancellation, and large-output
  artifacts.
- A typed worker protocol through which every workspace read, write, discovery,
  Git query, watch, and artifact ingress passes; the control plane receives no
  direct workspace filesystem access.
- WebSocket JSON-RPC APIs for sessions, runs, cancellation, records, events,
  context/provider-request inspection, artifacts, capabilities, and namespaced
  actions.
- Effective provider profile, driver/module versions, requests and usage, tool
  activity, error/retry, state owner, and provenance.

### Should

Branching, compaction, skill compatibility, MCP, approval, a basic web UI and
context inspector, discovery provenance, export, record/replay fixtures, and a
daemon-restart plugin development loop.

### May

Worktrees, sandboxing, subagents, orchestration, knowledge, memory, PTY, remote
executors, collaboration, notifications, scheduling, and frontend plugin ABI.

## First vertical slice acceptance

Start the daemon; configure a supported direct provider profile; create a
session and coding run through JSON-RPC; observe streamed model events;
route read and shell calls through the dispatcher; substitute one call through
middleware; edit a file; cancel in flight; restart and recover history; inspect
context and a redacted final request; load one context/tool module; and observe
the same core through a minimal web or test client without a TUI.

## Test matrix

- Fake provider: text stream, sequential/parallel tools, malformed chunks,
  retryable/permanent errors, timeout, cancellation, context rejection,
  structured output, and native opaque items.
- Fake tools: success, long stream, side effects, timeout, cancellation,
  invalid output, background resources, substitution, redirect, and suspension.
- State: crashes before journal commit and after commit/before publication,
  stale/duplicate commands, abandoned operations, module migration failure,
  module crash, and branch conflict.
- Workflow: single state owner, no transcript/UI duplication, no stale-file
  reactivation, no post-cancel continuation, idempotent scheduling, and no
  assumption that model stop equals workflow completion.
- Client parity: identical semantics through in-process API, JSON-RPC, web,
  optional CLI, and test harness.

## Delivery phases

0. Finalize ADRs for core/daemon, SQLite journal/state/outbox, driver, provider
   and transport, dispatcher/executor, trusted plugins, JSON-RPC, content model,
   and capability/credential boundaries.
1. Implement identity, command transactions, SQLite, journal/outbox, events,
   cancellation, module state, artifacts, and worker capability handles.
2. Add provider conformance tests, the first direct provider, context builder,
   default driver, streaming, and the tool loop.
3. Complete dispatcher middleware, the worker protocol, one development worker,
   one isolated worker, filesystem/shell/discovery tools, resource leases, and
   artifact projection.
4. Replace the spike HTTP server with WebSocket JSON-RPC, reconnect, snapshots,
   inspectors, capabilities, and actions.
5. Add the minimal web client.
6. Validate seams with a skill/context module, sandbox/policy middleware, and a
   worktree or subagent workflow before freezing public plugin APIs.

## Patterns to reject

Do not use prompts as authoritative workflow state; stop hooks as schedulers;
polled workspace files as canonical mailboxes; ANSI output parsing as UI state;
different dispatch paths for built-in and plugin tools; lossy provider
flattening; premature public hooks; bidirectional copies of module/core state;
Git as the definition of workspace; or broad “safe mode” claims that conflate
tool sandboxing, plugin isolation, and credential isolation.
