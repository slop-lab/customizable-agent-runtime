# ADR 0009: Durable adaptive pull-request review workflows

- Status: Accepted
- Date: 2026-08-24

## Context

CAR needs to coordinate project-specific review order before changes reach a
protected branch. A repository-owned YAML file is useful for static projects,
but making YAML the kernel contract would exclude providers that derive or
revise a plan from agent results, tool evidence, changed files, CI, or Git-host
events. Conversely, allowing plugins to mutate an unversioned plan would make
review order and merge-readiness decisions impossible to audit or reproduce.

DIM and OpenAI Symphony can eventually schedule work and reconcile external
state, while Gitea or another Git host can enforce branch protection and
required checks. Those systems have different authority. CAR must not claim
that orchestration alone prevents an unauthorized merge.

## Decisions

- Add a provider-neutral review-workflow service to the core runtime. The
  service owns workflow identity, the current head SHA, immutable enforcement
  constraints, ordered stage state, normalized evidence, merge-readiness
  projection, provider-version pinning, and revision compare-and-swap.
- Keep hard merge authority at the Git host and CI. CAR's readiness result is a
  durable policy decision that a future adapter publishes as a required check;
  it is not itself a remote merge lock.
- Make baseline enforcement immutable: a protected base, a pull request, at
  least one distinct human approval, and invalidation after a head change are
  mandatory. A provider can strengthen a plan but cannot remove these gates.
- Represent a plan as a validated acyclic graph of typed stages. Completion is
  accepted only after all direct dependencies are complete and the supplied
  structured evidence matches the stage-owned type/source/payload contract and
  a full 40-character SHA-1 or 64-character SHA-256 object ID.
- Append a full plan snapshot for every accepted workflow mutation, even when
  the provider returns no amendments. Revisions therefore provide one CAS
  counter and one chronological audit stream for evidence, stage completion,
  head changes, and dynamic plan decisions. Revision and evidence rows are not
  updated in place.
- Hash both plan snapshots and each stage's transitive gate definition. When an
  adaptive provider adds an upstream dependency, unchanged upstream results
  remain valid while the changed gate and all downstream completions reopen.
  A head change invalidates every old result because results and evidence are
  pinned to a commit SHA.
- Deep-clone and freeze provider identity, configuration, enforcement, plan,
  workflow, and evidence inputs before invoking provider code. Providers return
  additive amendments only; the core rejects stage redefinition and validates
  the resulting DAG and mandatory gates. Providers are registered and resolved
  by `id@version`, allowing old durable workflows to coexist with upgrades.
- Define a runtime-owned `ReviewWorkflowProvider` seam with deterministic
  `create` and `revise` operations. Validate it with two implementations, then
  expose namespaced providers through the existing fully trusted setup-time
  plugin registrar:
  - a declarative provider accepts JSON-compatible typed configuration; and
  - an adaptive provider appends a required risk review when normalized
    `risk.detected` evidence arrives.
- Bound provider revision input to the latest 100 current-head evidence items,
  ordered by portable `recordedRevision`, and expose
  `evidenceWindow.{limit,total,truncated}`. Providers carry durable derived
  policy in the plan instead of depending on an unbounded in-memory history.
  Current/list/mutation projections are also bounded; complete immutable audit
  data is available through revision-keyed history pages.
- Treat YAML as a future compiler input for the declarative configuration, not
  as storage or kernel state. DIM, Symphony, Git hosts, CI, agent reviewers, and
  tool middleware will integrate by selecting a provider, submitting normalized
  evidence, completing stages, or consuming readiness.
- Expose the first slice through the daemon's disposable HTTP API and basic web
  client. Public remote compatibility still waits for the planned WebSocket
  JSON-RPC action/event protocol.
- Defend the privileged local HTTP surface against browser cross-origin and DNS
  rebinding attacks with exact Host/Origin allowlists, JSON-only mutations, and
  a 128 KiB request limit. Non-loopback binding requires explicit allowed
  origins; these checks do not replace authentication or TLS.
- Treat current daemon/API evidence as operator-asserted claims. The readiness
  projection separates `ready` (the local policy simulation is satisfied) from
  `publishable` (all required evidence is adapter-attested). This slice has no
  attested admission path, so it never returns `publishable: true`. A future
  authenticated adapter must inject verified issuer identity and external
  references instead of accepting caller-claimed authority.
- Require caller-scoped external event IDs for evidence and head changes.
  Exact retries are idempotent; reuse with different evidence conflicts. Every
  accepted mutation appends a typed outbox event in the same transaction.

## Consequences

A local operator can create and drive an adaptive review workflow in the
browser or API, see why its local simulation is blocked, and restart the daemon without losing
the plan, evidence, results, or revision history. Concurrent stale mutations
fail rather than silently overwriting new policy decisions. Late risk evidence
reopens the exact transitive review path affected by the new requirement.

The first slice does not create a Gitea pull request, configure protected
branches, authenticate human identity, or publish a required commit status.
Trusted in-process plugins can provide dynamic policy, but this adds no plugin
isolation, hot reload, remote provider execution, or stable third-party ABI
promise. Git-host and identity adapters remain separate authority layers. Until
a Git-host adapter admits attested evidence and publishes only
`mergeReadiness.publishable`, `mergeReadiness.ready` remains advisory outside
this runtime.
