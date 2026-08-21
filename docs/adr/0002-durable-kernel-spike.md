# ADR 0002: Durable kernel and development worker spike

- Status: Accepted
- Date: 2026-08-21

## Context

ADR 0001 requires a SQLite journal/outbox and a worker boundary before the
first durable vertical slice. The implementation needed narrow answers for
SQLite ownership, crash recovery, internal ordering, trace redaction, and a
development worker without freezing the future public JSON-RPC or worker
lifecycle contracts.

## Decisions

- Use Node 24's built-in `node:sqlite` behind `KernelDatabase`. The verified
  environment provides SQLite 3.53 with WAL and backup support, so no native
  package dependency is needed.
- Permit one logical writer per database. Commands are serialized in-process;
  a mode-0600 atomic lock file rejects a second live process and is reclaimed
  after an ungraceful process exit by checking the recorded PID.
- Use schema-versioned migrations inside `BEGIN IMMEDIATE` transactions.
- Commit materialized state, immutable records, command receipts, and outbox
  events in the same transaction. Outbox sequence is an internal database
  cursor, not a public event-ordering promise.
- Treat delivery as at-least-once until an event is marked published. Event IDs
  are stable deduplication keys for consumers.
- Recover pending/running operations as `abandoned`; a stale run operation
  makes its run failed without changing already terminal operations.
- Keep runtime IDs opaque. The default remains random UUID, while tests inject
  deterministic generators. Sortability and branch semantics remain deferred.
- Redact structured credential fields before record/operation persistence.
  Provider-specific request redaction and retention policy remain required
  before a direct provider is added.
- Define an opaque workspace handle and typed worker requests for `readFile`
  and `shell`. The local development worker enforces root scope, symlink escape
  checks, deadlines, cancellation, and output limits. It receives an explicit
  environment projection rather than the daemon's raw environment.
- Do not choose pooled, per-run, or per-operation worker lifecycle yet. The
  local and fake implementations are protocol validators, not a lifecycle
  commitment.

## Consequences

The daemon now survives restart with durable sessions, runs, operations, and
records. A killed writer can restart without manual lock cleanup. Workspace
reads in the default distribution no longer occur in the control plane.

The PID lock assumes writers share a process namespace and filesystem, which
matches the initial single-host daemon. A distributed or remote database is a
different storage implementation. Shell side effects cannot be exactly-once;
an interrupted worker operation is recorded as failed or abandoned and may
require later reconciliation.

The following remain explicit decision gates rather than accidental contracts:

- direct provider and credential transport;
- worker lifecycle and isolated backend;
- public JSON-RPC sequence/ack/replay/flow control;
- artifact content addressing, quotas, and garbage collection;
- globally sortable identifiers and branch/archive semantics.
