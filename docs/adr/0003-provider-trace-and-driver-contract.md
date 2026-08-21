# ADR 0003: Provider trace, projections, and replaceable drivers

- Status: Accepted
- Date: 2026-08-21

## Context

CAR must support direct model APIs and later API routers without turning one
provider dialect or one agent loop into a kernel invariant. It must also let an
operator reconstruct failed attempts, including the exact provider semantics
observed before normalization.

## Decisions

- A replaceable driver owns context selection, repeated model invocation, tool
  continuation, and terminal-state policy. Runtime owns attempts, operations,
  cancellation, persistence, and event publication.
- The transport removes HTTP and SSE framing. The resulting provider semantic
  event payloads, in order, are the immutable provider-original trace.
- Provider event streams are append-only NDJSON artifacts. SQLite stores their
  metadata and attempt relationships, not one durable row per text delta.
- Normalized content is a versioned projection of provider events. The initial
  union is text, tool call, tool result, and provider-native opaque content.
- Each projection records its projector ID/version and source artifact/event
  range. Unknown provider fields and native steps are preserved.
- Provider capabilities use a versioned namespaced map. `core.*` names are
  portable; provider/router namespaces retain implementation-specific values.
- Every model invocation and retry is a separate attempt linked to its run,
  context projection, request/event artifacts, previous attempt, retry target,
  effective profile/capabilities, usage, finish reason, and error.
- Transport credentials are resolved from opaque handles and never enter
  provider requests, artifacts, records, logs, or inspectors.
- Provider request/event trace persistence is fail-closed by default. Explicit
  future trace modes may relax this, but silent loss is not allowed.
- The initial Google integration uses stateless Gemini Interactions requests.
  Provider-generated steps are preserved and resent exactly; CAR remains the
  authoritative history owner.

## Subsequent implementation note

The OpenRouter Chat Completions adapter follows the same trace rule:
its transport removes SSE framing, every decoded chunk is appended to the
provider-event artifact, and only then are text and indexed tool-call deltas
assembled. Raw provider usage is retained alongside a versioned normalized
usage projection; absent cost remains unknown.

## Demo defaults

- Sequential tool execution.
- At most 12 model attempts per run.
- A repeated identical tool call fails on its third occurrence.
- At most three transport retries for network, rate-limit, and temporary server
  failures, with recorded exponential backoff and jitter.
- Authentication, validation, and context-limit failures are permanent.
- Cancellation forbids further model or tool continuation.

These are driver/profile defaults, not kernel semantics.
