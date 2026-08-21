# Execution topology and sandbox boundary

## Chosen topology

The preferred topology to evaluate keeps the trusted control plane outside a
tool sandbox and runs untrusted workspace effects inside isolated workers.

```text
trusted host process
  SQLite, journal, scheduler, provider transports, context pipeline,
  plugin registry, API, artifact metadata
        |
        | typed capability protocol
        v
sandboxed execution worker
  workspace filesystem, shell, processes, tool-specific network access
```

This topology is independent of any workspace manager or deployment product.
An execution backend may use a local process, container, VM, or remote worker,
but those are implementations of CAR's worker protocol rather than concepts in
the runtime domain model.

## What it gains

- SQLite, provider credentials, control sockets, policy state, and audit data
  need not be reachable by arbitrary workspace commands.
- A tool worker can be killed, replaced, resource-limited, and selected per
  operation without taking down session state or clients.
- The boundary naturally validates the executor abstraction and makes local,
  container, VM, SSH, and simulated executors comparable.
- Control-plane recovery is independent from a corrupted tool environment.
- Only capability-scoped operations need cross the boundary; raw host sockets
  and secrets do not.

## What it loses or makes harder

### It is not full runtime isolation

Trusted in-process plugins, provider adapters, context contributors, and the
daemon still execute with control-plane authority. A malicious or vulnerable
plugin can read SQLite, traces, environment variables, network resources, and
process memory or bypass the dispatcher entirely. Calling this architecture a
“sandboxed runtime” would be inaccurate; only dispatched execution is
sandboxed.

### All workspace access becomes protocol work

Context discovery, skill loading, Git inspection, file watching, and artifact
collection may not read workspace paths in the host process. They must become
worker operations, use capability-scoped services, or consume worker-produced
snapshots. This preserves the boundary but adds protocol surface and latency.

### Provider-hosted tools cannot be enclosed locally

Server-side web search, code execution, file retrieval, or computer-use tools
run under the provider's boundary, not CAR's worker. CAR can record and policy-
gate the request but cannot claim local sandbox enforcement.

### Rich and long-lived tools require a resource protocol

PTYs, background processes, browsers, language servers, streaming logs, and
interactive approvals are not simple request/response calls. Workers need
leases, handles, heartbeats, cancellation, reconnect, output flow control, and
orphan recovery. Otherwise resources leak or become permanently `running` after
a crash.

### Transactions stop at the process boundary

SQLite can atomically record intent and state, but it cannot atomically commit a
filesystem or external side effect. The runtime needs operation IDs,
idempotency, an intent/result journal, uncertain-outcome states, reconciliation,
and compensation. “Exactly once” tool execution is generally unavailable.

### Reproduction requires two manifests

Replaying model/control decisions is insufficient to reproduce tool results.
The worker image, platform, mounts, workspace snapshot, environment projection,
network policy, tool versions, locale, and resource limits must also be hashed
or recorded. A host-only trace can otherwise overstate reproducibility.

### Performance and ergonomics change

Every filesystem query, stream delta, and cancellation crosses IPC. Large
outputs need artifact transfer rather than JSON-RPC buffering. Debugging spans
host and worker logs. Very small tools may pay material startup costs unless
workers are pooled, which creates new cleanup and state-leak risks.

### Capability design becomes security-critical

A raw path, environment map, arbitrary command, inherited file descriptor, or
general network proxy can collapse the boundary. Capabilities need explicit
scope, expiry, actor/run binding, attenuation, revocation, audit, and denial by
default. The protocol must distinguish data from authority.

## Required architectural rules

1. The host process is trusted; the workspace and tool worker are untrusted.
2. Every workspace access, including read-only discovery and metadata queries,
   is routed through a worker capability. There is no trusted host-side
   workspace filesystem exception.
3. Provider authentication is resolved outside the provider interface and raw
   credentials never enter records or ordinary tool contexts.
4. Every in-process plugin is fully trusted control-plane code. It receives no
   sandbox guarantee and may access control-plane memory and authority. A
   restricted plugin, if introduced later, must be out of process and use a
   different contract.
5. Commands persist intent before dispatch and persist terminal or uncertain
   outcome afterward. Recovery reconciles abandoned operations.
6. Worker resources use stable opaque handles and leases rather than host PIDs,
   container IDs, or filesystem paths as public identity.
7. Artifact ingress verifies size, hash, ownership, and content type before the
   control plane accepts metadata references.
8. Security profiles state separately what isolates plugins, model transports,
   tools, workspace data, network, and credentials.

## Recommendation

Implement this split from the first durable slice, but define it as a sandboxed
execution plane rather than a sandboxed runtime. Keep SQLite in the trusted host
and make domain IDs, commands, events, capabilities, and worker handles
storage-independent. Before expanding the plugin API, implement one development
worker and one isolated worker against the same protocol; the second
implementation validates the boundary.
