# ADR 0005: Worker artifact ingress and process lifecycle

- Status: Accepted
- Date: 2026-08-22

## Context

The development worker currently returns one bounded string or an output-limit
error. That loses large successful output and cannot validate the worker
boundary with a second implementation. ADR 0004 also records only the host's
worker identity; a worker-produced execution-environment manifest is still
needed to distinguish a claimed backend from the process that executed tools.

The next slice must preserve complete tool output, validate ownership before the
control plane accepts it, and exercise cancellation and crash recovery across a
real process boundary without claiming container, VM, network, or credential
isolation that it does not provide.

## Decisions

- Add a private artifact-ingress staging root distinct from both the workspace
  and the durable artifact store. Workers return an opaque descriptor, never a
  staging path.
- A descriptor binds version, ingress ID, operation ID, kind, media type, byte
  length, and SHA-256. The host validates every field, the expected operation,
  the actual file size and hash, and the configured maximum before promotion.
- Promote a verified ingress file to an operation-owned durable `tool-output`
  artifact. The model-facing result contains a bounded head/tail projection and
  an `artifact://` reference; the full output does not become a record payload.
- Keep artifact IDs opaque and host-generated. Worker ingress IDs are temporary
  transfer handles, not public artifact identity.
- Implement the second backend as a lazily started Node child process using a
  versioned JSON-lines protocol over private stdio. It receives one workspace
  root, one opaque workspace handle, an explicit environment projection, and
  bounded output/artifact limits.
- Use an opaque renewable lease for the child. The parent renews a live lease,
  rejects stale responses, terminates expired workers, and starts a fresh worker
  after expiry or crash. Active side-effecting requests fail with an uncertain
  outcome if the process disappears.
- The child produces a versioned execution manifest containing its component,
  lease, Node/platform identity, opaque workspace handle, environment key names,
  declared process-isolation properties, resource limits, and request types. It
  never includes environment values or the host workspace path.
- Persist the first validated execution manifest per run and lease as immutable
  structured JSON plus a canonical SHA-256 digest. Repeated reports must match.
- Describe this backend as process-isolated, not sandboxed. It shares the host
  user, kernel, and inherited network policy. Container/VM isolation and remote
  attestation remain separate backends and security decisions.

## Consequences

Large output becomes durable and inspectable without expanding model context or
using workspace paths as transfer authority. A second worker validates request
serialization, cancellation, lease expiry, process restart, and environment
projection while preserving the existing local worker for fast development.

The staging root is a trusted host/worker handoff area and needs later quota,
garbage-collection, and orphan sweeping policy. Process isolation reduces shared
memory and lifecycle coupling but is not a security sandbox.
