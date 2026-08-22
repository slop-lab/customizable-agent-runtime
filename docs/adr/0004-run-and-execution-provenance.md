# ADR 0004: Immutable run and execution provenance

- Status: Accepted
- Date: 2026-08-22

## Context

CAR retains provider-native traces, normalized projections, tool activity, and
usage, but those values do not identify the effective runtime, policy, schemas,
workspace, or execution backend that produced a run. A host-only trace also
cannot reproduce worker effects: the worker image and version, workspace
snapshot, environment projection, network policy, and resource limits are a
separate execution concern.

The first provenance slice must improve inspection without scraping Git from a
trusted host at run time, persisting credential values, or freezing the future
worker lifecycle and artifact protocols.

## Decisions

- Persist exactly one versioned, immutable provenance manifest when a run is
  accepted. The manifest is part of the same transaction as the run, root
  operation, first record, and outbox events.
- Store a SHA-256 digest of a canonical JSON encoding beside the structured
  manifest. The digest is an integrity and comparison aid; it does not replace
  inspectable fields.
- Record runtime package identity and a host-injected source revision. Core does
  not execute Git or infer a revision from the current workspace.
- Record the driver ID/version and its effective structured configuration,
  including attempt, retry, backoff, and repeated-call policy when applicable.
- Record provider adapter/profile/capabilities and transport identity. Opaque
  credential handles may identify a deployment slot, but credential values
  never enter the manifest.
- Record the context projector ID/version and every active tool ID/version plus
  a stable hash of its canonical input schema. Tool order does not affect the
  manifest.
- Record the opaque workspace handle, optional host-supplied workspace identity,
  security profile, and redaction-policy identity.
- Treat the execution worker as a distinct versioned component. The initial
  manifest records its backend identity and safe configuration when available;
  a later isolated-worker slice will add a worker-produced execution manifest
  covering image, platform, mounts, workspace snapshot, environment projection,
  network policy, tool versions, locale, and resource limits.
- Apply the configured trace redactor before canonicalization and persistence.
  Persist the redacted structured projection as well as its digest.
- Permit lifecycle deletion to remove a manifest with its run, but reject
  in-place updates. Corrections require a new run or a future explicitly linked
  annotation rather than rewriting historical provenance.

## Consequences

Operators can compare runs and determine which effective components and policy
produced them without relying on terminal output or ambient repository state.
Schema hashes make tool-contract changes visible while leaving descriptions and
presentation wording outside the schema identity.

The manifest records claims supplied by the trusted host and current in-process
components; it is not remote attestation. Full reproduction remains incomplete
until a genuinely isolated worker produces and signs or hashes its own execution
manifest and artifact ingress verifies ownership, size, content type, and hash.
