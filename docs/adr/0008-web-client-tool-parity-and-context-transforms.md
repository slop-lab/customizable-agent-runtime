# ADR 0008: Functional web client, coding tools, and context transforms

- Status: Accepted
- Date: 2026-08-24

## Context

CAR has a durable runtime, provider adapters, workspace workers, trusted
plugins, and inspection APIs, but its reference daemon still requires an
external HTTP client. Its default tools cover the original vertical slice
rather than the common coding-agent vocabulary used by OpenCode and OMP. The
default context projector also sends every model-visible record on every
attempt, leaving only provider-owned context management available.

The next slice should make CAR useful from a browser without choosing a lasting
frontend framework or prematurely implementing the final WebSocket JSON-RPC
protocol. It should also add deterministic, inspectable context reduction
without rewriting authoritative session history.

## Decisions

- Serve a same-origin, dependency-free web client from the daemon. It provides
  session selection and creation, prompt submission, run status and
  cancellation, transcript rendering, tool-call/result inspection, and basic
  capability/plugin visibility. Visual design and a frontend plugin ABI remain
  outside this slice.
- Change the HTTP run command to start work asynchronously and return the
  accepted running snapshot with status 202. The client polls durable run and
  record projections. Its API boundary remains small so polling can later be
  replaced by the canonical WebSocket JSON-RPC event protocol.
- Add the common coding-agent tool names `bash`, `glob`, `grep`, and `edit`, plus
  `git_diff`, while retaining the pre-stable `shell`,
  `list`, and `search` tools for existing-session compatibility. All workspace
  operations continue through the typed worker protocol and every tool call
  continues through the unified dispatcher.
- Introduce ordered, provider-neutral context transforms after durable records
  are normalized and before a provider adapter encodes its request. Transforms
  operate only on an attempt projection; they never delete or mutate records or
  artifacts.
- Persist each applied transform's identity, version, configuration, decision
  list, and input/output hashes with the context projection. Capture configured
  transform identity and configuration in immutable run provenance version 2;
  existing version-1 manifests remain readable without transform metadata.
- Validate transformed tool structure before provider invocation. A tool result
  must retain a preceding matching tool call, and duplicate call/result IDs are
  rejected. Transform failure persists a failed projection and model attempt,
  then fails the run rather than silently sending an untransformed context.
- Supply one deterministic default transform that prunes old successful tool
  result payloads. At 20 completed tool exchanges it replaces the oldest ten
  outputs with a fixed tombstone while preserving call IDs, tool names, inputs,
  order, errors, artifacts in durable storage, and the newest ten exchanges.
  It advances in ten-exchange batches so the projected prefix changes less
  often for provider prompt caches. Protected tool names and the three counts
  are configurable programmatically.
- Context summarization that invokes a model and provider-specific raw request
  hooks are separate future seams. Execution-time tool middleware is not used
  for context reduction.

## Consequences

A fresh checkout can start the daemon and operate a basic coding agent from a
browser. The client remains intentionally replaceable, and the temporary HTTP
transport gains no false stability promise.

Long tool-driven sessions receive bounded historical tool payloads without
losing audit history. Inspectors can distinguish the original records from the
exact transformed projection used by an attempt and can reproduce the active
policy. Count-based pruning is deliberately simple; token-aware summarization,
provider cache metadata, approval/input suspension, LSP, skills, task agents,
and browser automation remain follow-up work.
