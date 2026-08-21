# Architecture

CAR separates four planes so that presentation and workflow choices do not
become runtime invariants.

```text
clients -> versioned API -> runtime host
                            |-- runtime kernel
                            |-- default distribution
                            |-- modules
                            |-- provider adapters -> transports
                            `-- tool dispatcher -> executors
```

The control plane owns identity, commands, lifecycle, cancellation, records,
and events. The model plane owns context projection and provider requests. The
execution plane owns tools and external side effects. The presentation plane
is an API client and owns no authoritative runtime state.

## Dependency rules

- `@car/core` is embeddable and knows no HTTP, persistence, or vendor SDK.
- `@car/defaults` composes a useful agent driver and built-in modules from core
  contracts.
- `@car/daemon` adapts the same in-process API to a versioned network API.
- Every model-visible tool invocation passes through one dispatcher.
- Provider adapters and transports are separate contracts.
- Provider-native values may be retained alongside normalized content.
- Modules own mutable state in explicit namespaces; prompts and workspace files
  are not authoritative control state.

## Initial domain model

A session is a durable user-visible container. A branch selects a history head
and is not a Git branch. A run is one driver execution. An operation is a
cancellable unit of work within or beside a run. A record is immutable history,
and an artifact stores large or binary content outside a record.

The spike implements sessions, runs, records, events, model invocation, and
tool dispatch in memory. SQLite persistence, branching, artifacts, suspension,
and module state are planned kernel capabilities, not claims of completed
functionality. The canonical remote protocol will be WebSocket JSON-RPC 2.0;
the current small HTTP endpoint is disposable spike code.

## Provider boundary

CAR owns a provider-neutral, capability-driven model interface. Provider
adapters translate content and streaming semantics; credentials are supplied to
transports through opaque credential handles and are not part of the provider
interface. No complete coding-agent product is a priority provider backend.
The fake provider remains the first conformance implementation, followed by a
direct model API selected for its usefulness in runtime experiments.
