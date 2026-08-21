# Product and architecture requirements

## Status and audience

This is the complete, portable design baseline for Customizable Agent Runtime
(`car`). It targets expert users who are comfortable assembling development
environments and tools. Productivity, observability, experimentation, and
incremental extensibility take priority over beginner onboarding, a polished
TUI, mandatory sandboxing, or general-purpose SaaS operation.

`MUST` requirements constrain the architecture from the start. `SHOULD`
requirements may arrive later but the design must not block them. `MAY`
requirements are optional. The core owns invariants and shared execution
mechanisms; the default distribution supplies useful replaceable behavior; a
module is a replaceable component in this codebase; a plugin is an extension
unit that does not require core modification.

## Goals

CAR must make it possible to:

1. Use multiple model providers and custom endpoints.
2. inspect and transform stored history, active context, and the final provider
   request independently;
3. execute, deny, replace, suspend, or redirect model tool calls through one
   path;
4. experiment with coding-agent loops and unrelated agent workflows;
5. add workspaces, worktrees, sandboxes, subagents, orchestration, knowledge,
   memory, and collaboration without hard-coding one meaning into the core;
6. observe and control core behavior over a network API;
7. provide a web client independently from the daemon;
8. support remote use through localhost plus SSH forwarding or a private
   network without requiring a TUI; and
9. keep early source-level experiments easy to extract into modules later.

## Non-goals for the initial core

The initial core does not aim to provide zero-configuration onboarding, a
terminal-occupying UI, a stable shell automation CLI, mandatory containerized
tools, mandatory credential isolation, one fixed approval or sandbox policy,
one orchestration model, Git-only workspaces, MCP as the internal tool model, a
stable third-party plugin ABI, multi-tenant SaaS, billing, organization
management, or long-term compatibility with a UI framework or database schema.

## Core ownership

The core owns stable identity, command acceptance and state transitions, run
and operation lifecycle, cancellation and failure propagation, model
invocation, tool dispatch, durable records, structured event publication,
explicit module dependencies, API-level observation and control, and isolated
module-state ownership.

It must not define product semantics such as whether new input interrupts a
run, whether insertion is called steering, who declares a workflow complete,
whether a subagent is a session or actor, whether approval belongs to a tool or
workflow, whether a worktree belongs to a session, whether compaction rewrites
history, whether plans are transcript items, or whether a shell sandbox covers
plugin code. A default driver may define those semantics.

## Architectural principles

### API-first, embeddable core

The in-process API and versioned network API must express the same commands.
Web, IDE, optional CLI, automation, and tests are clients. No API should inject
terminal input or imitate a TUI implementation.

### Separate planes

- The control plane owns session, run, workflow state, scheduling,
  cancellation, approval state, module state, and branches.
- The model plane owns instructions, messages, context, tool schemas, provider
  requests, responses, and usage.
- The execution plane owns filesystem, shell, browser, MCP, background
  processes, sandboxes, remote executors, and side effects.
- The presentation plane owns web/CLI rendering, diffs, logs, notifications,
  and collaboration views.

One plane's text representation must not serve as another plane's source of
truth.

### One authoritative owner per state

Runtime state, transcripts, module files, UI caches, terminal environment,
prompts, and generated Markdown must not independently own the same state. A
module's typed namespace is authoritative; transcripts and UI are projections.
Files may be exports or compatibility views only.

### Progressive extension

Create internal seams before publishing hooks. Add a default implementation,
test a second real implementation, then promote only repeated and coherent
interfaces to a public plugin API. Prefer stable low-level primitives such as
input delivery, cancellation, record append, child runs, suspension, external
responses, and scheduling over fixed meanings for steering, approval,
subagents, compaction, memory, collaboration, or sandboxing.

### Unified tool dispatch

Every agent-visible tool follows resolution, input validation, middleware,
policy or approval, executor selection, result middleware, persistence, and a
model-facing projection. Trusted in-process plugin code is outside that tool
sandbox boundary.

### Worker-owned workspace I/O

The control plane does not directly read, write, watch, or inspect workspace
paths. File operations, discovery, Git metadata, skill and rule loading, search,
and artifact collection cross the execution-worker protocol through scoped
capabilities. This boundary is part of CAR and does not refer to a particular
workspace manager or deployment system.

### Observability before convenience

For every meaningful action, an operator should be able to determine the
responsible module, effective input and configuration, exact model projection,
actual tool execution, authoritative state owner, stop/retry/continuation
reason, and reproducibility data.

### No lowest-common-denominator providers

Normalized content must coexist with provider-native opaque values for
reasoning, caching, tool semantics, structured output, images and files,
citations, parallel calls, server-side conversation state, usage and cost,
finish reasons, error details, and retry hints. Cross-provider branches use an
explicit fallback projector that preserves, annotates, converts, or omits each
native value.

### Visible ambient discovery

Rules, skills, MCP servers, plugins, and provider profiles may be discovered
from directories, but the runtime must record source paths, precedence,
effective activation, versions, content hashes, and session-specific changes.

### Remote control

The daemon, workspace, and tools normally remain on the remote host. The UI
connects through an SSH tunnel, private network, or reviewed reverse proxy.
Default binding is localhost. Public exposure, authentication, and TLS are
deployment responsibilities.

## Default distribution

The default distribution should provide a coding driver, shell/read/search/edit
tools, session and history management, context assembly and compaction, skill
compatibility, provider integrations, a web client, MCP integration, and an
approval policy. Each remains replaceable rather than a kernel invariant.

## Experiment reproducibility

Each run should preserve runtime and driver versions, enabled modules and
configuration hashes, provider profile and capabilities, context projection
hash and included record IDs, tool schemas and versions, workspace identity,
security profile, attempts and retries, token usage and cost, and terminal
status. Trace policy supports metadata-only, redacted, full-local, and disabled
modes. The default is full local preservation for meaningful transcripts,
contexts, provider exchanges, tool activity, state transitions, and provenance,
subject to explicit secret redaction and bounded binary/artifact storage.
