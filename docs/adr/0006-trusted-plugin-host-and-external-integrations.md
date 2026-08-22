# ADR 0006: Trusted plugin host and external integrations

- Status: Accepted
- Date: 2026-08-22

## Context

CAR now has a durable tool dispatcher, provider boundary, artifacts, and a
second worker implementation. The next extension seam should let deployments
connect systems such as Git hosts, issue trackers, and MCP servers without
adding each integration to the kernel. It must not imply that plugin code is
sandboxed or publish a broad third-party ABI before more than one integration
has exercised the contract.

Two ignored local references informed this decision:

- OMP at `9350b79` separates extension registration from initialized runtime
  actions, routes custom tools through the normal tool registry, contains
  handler failures and timeouts, and owns timer cleanup. Its extension API is
  also tightly coupled to session and terminal UI internals, exposes direct
  process execution, accepts many discovery sources, and permits per-extension
  load failure without a deterministic dependency graph.
- OpenCode at `1b937c8` accepts explicit package-plus-options declarations,
  separates resolution, compatibility, import, and activation failures,
  applies loaded hooks sequentially, and uses child scopes plus keyed loading
  to replace and remove plugins safely. Its dynamic npm installation,
  compatibility layers, mutable host facades, hot replacement, and broad
  effect graph are larger than CAR needs for the first seam.

CAR needs the lifecycle and determinism lessons without copying either
product's UI ownership, dynamic package manager, or compatibility surface.

## Decisions

- The initial plugin contract is pre-stable and trusted, in-process code. It is
  not protected by the execution-worker boundary and has control-plane
  authority.
- Plugins are supplied explicitly by the trusted host. This slice has no
  directory scanning, dynamic import, npm installation, hot reload, or
  third-party compatibility negotiation.
- A versioned manifest declares a qualified plugin ID, plugin version,
  dependencies, and a structured configuration projection. Configuration is
  redacted before run provenance is persisted; credential values are never
  configuration fields.
- Initialization validates all manifests first, rejects duplicates, missing
  dependencies, self-dependencies, and cycles, and derives a deterministic
  topological order with lexical ID tie-breaking.
- Plugin setup is a registration-only phase. Registration APIs become invalid
  as soon as setup returns. Runtime actions are deliberately absent from this
  first host contract.
- The first additive surfaces are model tools and tool middleware. Plugin tools
  must use the plugin ID as their namespace and enter the same validation,
  middleware, persistence, provenance, cancellation, and model projection path
  as built-in tools.
- Setup and start run sequentially in dependency order. Explicitly configured
  plugin failure is fail-fast for host creation. Cleanup runs in reverse order
  and attempts every registered cleanup even when one fails.
- Health checks are bounded inspection calls. A health-check exception becomes
  an inspectable failed health result rather than a daemon failure.
- Active plugin identity, dependency order, redacted configuration, and tool
  schemas are captured in run provenance. Capabilities and the daemon plugin
  inspector expose identities and health but not configuration values.
- The first real implementation is a read-only Gitea integration plugin. Its
  HTTP transport resolves an opaque credential handle only at request time and
  exposes bounded repository and pull-request projections rather than a generic
  arbitrary-HTTP tool.

## Consequences

External integrations can ship as separate packages without bypassing the tool
dispatcher or leaking credential values into model context and provenance. The
small host establishes deterministic lifecycle and cleanup before discovery or
reload semantics make those behaviors harder to change.

This does not yet provide namespaced module state, durable subscription cursors,
event consumers, namespaced actions, provider/context registration, dynamic
plugin loading, a public compatibility promise, or restricted plugin execution.
Those surfaces should be added only when a concrete second integration needs
them. VM/container isolation is not a prerequisite for this trusted plugin
model and remains outside this project's current scope.
