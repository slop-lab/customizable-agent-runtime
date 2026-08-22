# Domain, persistence, and trace model

## Domain objects

- A **session** is a persistent user-visible work container with metadata,
  branches, workspace references, a default driver profile, and lifecycle.
- A **branch** selects the history head used for future context. It is distinct
  from a Git branch, worktree, or workspace clone.
- A **run** is one driver execution: a user request, scheduled continuation,
  child-agent task, or review.
- An **operation** is cancellable long-running work such as a model call, tool
  call, compaction, plugin command, child run, workspace creation, or process.
  Its lifecycle is `pending -> running -> completed | failed | cancelled |
  abandoned`, with crash recovery for stale running operations.
- A **record** is immutable meaningful history: input, assistant content, tool
  call/result, context injection, compaction, workflow transition, annotation,
  error, or artifact reference. It carries provenance, actor/module, causation,
  visibility, scope, and lifetime.
- An **artifact** stores large or binary output such as logs, diffs, images,
  snapshots, traces, archives, and reports. Records contain references.
- **Module state** is versioned mutable state in a module-owned namespace with
  migration and transactional event publication.
- A **resource** is a longer-lived external object such as a PTY, process,
  browser, SSH connection, worktree, remote workspace, or worker.

## SQLite storage

SQLite is the initial persistence engine and should run in WAL mode. One
runtime command processor is the logical writer. A transaction may update core
materialized state, update namespaced module state, append journal records, and
append an outbox event before commit. Publication consumes the outbox so a
crash after commit but before delivery is recoverable.

The immutable journal stores user/model-visible history, model and tool calls,
operation lifecycle, significant workflow transitions, effective component
provenance, errors, and cancellation. Mutable tables store session metadata,
active runs, queues and leases, module state, UI indexes, and cached
projections. Full event sourcing is not required, but every meaningful action
must remain traceable and conflicts between current state and journal require a
defined recovery rule.

SQLite stores artifact metadata, hashes, ownership, and retention state. Large
payloads live in a content-addressed filesystem store initially; putting
unbounded blobs in the database is not the default.

SQLite does not define domain identity or branch semantics. IDs are generated
by the runtime before persistence and remain opaque strings at API boundaries.
Foreign keys, row IDs, transaction IDs, and insertion order are storage details
and must not become public identity, causation, or event ordering. A future
storage adapter must be able to preserve the same IDs, revision checks,
idempotency keys, and branch graph.

## Trace retention

Meaningful traces are preserved by default, including transcripts, record
graphs, active-context projections, redacted final provider requests and
responses, tool inputs/results, lifecycle events, retries, usage, effective
configuration, and provenance. Raw secrets, credential material, and explicitly
sensitive fields are never retained merely because full tracing is enabled.

Each accepted run has one immutable versioned provenance manifest stored in the
same transaction as the run, root operation, first record, and outbox events.
The structured redacted manifest is authoritative; its canonical SHA-256 digest
supports integrity checks and comparisons without hiding configuration behind a
hash. Runtime source revision is supplied by the trusted host rather than
scraped from the workspace. Worker identity is recorded separately from the
first validated, immutable worker-produced execution manifest for each run and
opaque worker lease. The execution manifest retains the child runtime/platform
identity, environment key names, resource limits, request types, and canonical
digest; it excludes environment values and the host workspace path.

Retention needs separate policies for searchable metadata, transcript and
structured trace, large artifacts, and sensitive/redacted material. Export and
deletion must include module state and artifacts, not just conversation rows.

## History is not context

Keep four representations distinct:

1. canonical history: immutable records and branch relations;
2. active model context: a provider-neutral projection for one model call;
3. provider request: the adapter's actual request representation; and
4. presentation transcript: a client-specific user view.

Records independently specify model, conversation, operator, audit, and export
visibility. Provenance may identify a user, agent, driver, policy, skill,
memory, knowledge source, workflow, import, or compatibility adapter.

The context pipeline selects branch records, filters visibility, composes
instructions, contributes memory and knowledge, compacts/prunes, projects tool
schemas, produces provider-neutral context, adapts it for a provider, applies a
final transform, and sends it through a transport. An inspector shows included
and excluded records with reasons, instruction sources, active skills,
retrieval sources, compaction ranges, tool schemas, neutral context, redacted
final request, component versions, and effective configuration.

External modules may append conversation-visible user input, model-only
instructions, operator-only annotations, workflow-control records, and imported
history. They must not disguise policy as user input, continuation as a new user
request, or plugin state as assistant text.
