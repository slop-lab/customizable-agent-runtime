# ADR 0001: Initial architecture

- Status: Accepted
- Date: 2026-08-20

## Context

CAR needs an experimental agent runtime that can expose the same semantics as
an embeddable library and a remote daemon. It must permit different providers,
drivers, context pipelines, tool policies, and workflows without making those
product choices kernel invariants.

## Initial decisions

- Use TypeScript on Node.js 24/26 with pnpm.
- Keep all components in one repository with package-level boundaries.
- Build an embeddable core and a reference daemon.
- Use WebSocket JSON-RPC 2.0 as the canonical network API, while retaining an
  equivalent typed in-process API.
- Keep the agent loop behind a replaceable driver contract.
- Separate provider request adaptation from transport and authentication.
- Route every agent-visible tool through one dispatcher with middleware and
  substitute-result support.
- Use SQLite for the journal, materialized state, module namespaces, and a
  transactional event outbox; store large artifacts outside the database.
- Treat every in-process plugin as fully trusted control-plane code. Restricted
  plugins require a future out-of-process contract; promise no stable
  third-party plugin ABI yet.
- Preserve normalized content and provider-native opaque data.
- Prefer an immutable journal plus mutable materialized state over full event
  sourcing.
- Preserve meaningful transcripts and traces locally by default, with explicit
  secret redaction and configurable retention/export/deletion policies.
- Keep authentication outside the capability-driven provider interface.
  Provider transports receive opaque credential handles from deployment code.
- Keep the control plane outside the execution sandbox and route every
  workspace access, including read-only I/O and discovery, through a worker
  capability. The runtime model does not include deployment-product concepts.

## Remaining high-impact decisions

These choices have no sufficiently clear recommendation yet and should be
resolved with narrow spikes before Phase 1 hardens the contracts:

1. **First direct model provider.** Choose a supported direct model API based on
   experimental coverage rather than account convenience. Authentication is a
   separate transport/deployment decision.
2. **JSON-RPC event durability and flow control.** Define sequence scope,
   replay windows, acknowledgement, bounded queues, overload errors, and when a
   client must recover from a snapshot.
3. **SQLite ownership and concurrency.** Confirm whether one daemon process is
   the only writer, define nested command behavior, migration locking, outbox
   leases, backup, and corruption recovery.
4. **Trace security and lifecycle.** Define redaction before persistence,
   encryption-at-rest expectations, retention duration/quotas, export, selective
   deletion, and how derived summaries are erased.
5. **Plugin contract discovery and order.** Select manifest format, dependency
   resolution, deterministic middleware ordering, config schema, state
   migration ownership, and failure defaults before accepting third-party
   in-process plugins.
6. **Workspace authority.** CAR should support non-Git workspaces, but the
   ownership and lifecycle contract for local, worktree, container, VM, and
   remote workspaces still needs definition.
7. **Identifier and branch semantics.** Choose globally sortable IDs, branch
   graph rules, optimistic concurrency/idempotency keys, and deletion/archive
   semantics before the API becomes externally consumed.
8. **Artifact ownership.** Define content-addressing, deduplication, quotas,
   streaming, garbage collection, and referential integrity with SQLite.
9. **Configuration and secret precedence.** Define repository/user/runtime
    sources, hashes, reload behavior, secret handles, and what is safe to expose
    through inspectors and exports.
10. **Worker lifecycle and granularity.** Decide whether workers are pooled per
    workspace, created per run, or created per operation, and define cleanup,
    lease, crash recovery, and state-leak guarantees.

UI framework, out-of-process plugin protocol, sandbox implementation,
orchestration model, multi-tenancy, and stable CLI syntax remain intentionally
deferred because they do not block the kernel slice.
