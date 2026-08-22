# ADR 0007: Bounded remote MCP tool plugin

- Status: Accepted
- Date: 2026-08-22

## Context

The trusted plugin host and read-only Gitea integration prove static tool
registration, but they do not exercise remote tool discovery, protocol-owned
schemas, cancellable external calls, or asynchronous connection cleanup. A
second concrete integration should validate those seams before CAR expands its
plugin API abstractly.

The official TypeScript SDK 2.0 splits the client into
`@modelcontextprotocol/client`. Its client guide recommends
`StreamableHTTPClientTransport` for remote servers, paginated `listTools` for
discovery, `callTool` for invocation, request signals for cancellation, and
asynchronous client close. MCP tool annotations are explicitly hints rather
than enforcement, and list cursors are opaque and session-scoped.

Two ignored local references also informed the boundary:

- OMP at `9350b79` bridges MCP tools into its normal tool registry, sorts the
  resulting definitions deterministically, bounds notification buffers, and
  guards reconnect storms. It also discovers many third-party configuration
  formats and owns profiles, OAuth, resources, prompts, notifications, reload,
  and compatibility behavior that CAR does not need in this slice.
- OpenCode at `1b937c8` keeps MCP clients and definitions separate, closes a
  failed transport during acquisition, exposes connection status, and warns
  that large MCP catalogs consume model context. Its stdio, legacy SSE, OAuth,
  mutable catalog, resource, prompt, and UI management surfaces remain outside
  this slice.

## Decisions

- Add a separate `@car/plugin-mcp` package. One plugin instance represents one
  explicitly configured remote MCP server and uses plugin ID
  `integration.mcp.<server-id>`.
- The production adapter uses `@modelcontextprotocol/client` version 2 and
  remote Streamable HTTP only. It enables automatic protocol-era negotiation
  so a modern server may be used without abandoning supported 2025-era
  servers.
- No directory scanning, config-file compatibility, package installation,
  stdio process spawning, legacy SSE fallback, OAuth flow, resources, prompts,
  sampling, elicitation, tasks, notifications, tool-list refresh, or hot reload
  is included.
- The trusted host supplies endpoint, optional opaque bearer credential handle,
  exact raw tool-name allowlist, and limits. Credential values are resolved by
  the transport immediately before an authenticated request and never enter
  the manifest or tool result.
- Setup connects, walks opaque `tools/list` cursors, validates configured tools,
  and registers tools before activation. Catalog size, pagination, schema size,
  descriptions, call duration, and projected result size are bounded.
- The allowlist is the deterministic authorization boundary. The first slice
  additionally requires `readOnlyHint: true` by default, but does not treat a
  server-provided annotation as a security guarantee. Unknown allowlist entries,
  missing read-only hints, duplicate raw names, or canonical-name collisions
  fail initialization.
- Raw MCP tool names are preserved for calls. Model-visible names are canonical
  lowercase qualified IDs under the plugin namespace. Normalization collisions
  are rejected rather than silently renamed.
- MCP input schemas enter the existing `ToolDispatcher` and run provenance.
  The remote MCP server remains the authoritative argument validator. CAR
  locally requires an object input and forwards no host-only fields.
- Tool calls receive the runtime cancellation signal plus a bounded timeout.
  MCP text and textual embedded-resource content are projected to bounded text.
  Binary payloads are represented by bounded metadata rather than base64. An
  oversized aggregate result fails closed instead of entering model context.
- Extend the pre-stable plugin lifecycle so `stop` and host/runtime close may be
  asynchronous. Shutdown remains reverse-order, attempts every cleanup, closes
  durable runtime resources even after a cleanup error, and reports aggregate
  cleanup failure.
- The daemon opt-in initially supports one server through explicit environment
  variables. Programmatic hosts may compose multiple plugin instances.

## Consequences

CAR gains a real protocol integration without creating a second tool dispatch
path or importing MCP concepts into the kernel. Remote-discovered schemas and
server identity become inspectable through capabilities, plugin health, and
run provenance, while credentials and binary bodies remain outside model
context.

The first MCP integration is intentionally unsuitable for arbitrary unreviewed
servers or write-capable tool catalogs. Approval policy, side-effect metadata,
dynamic catalog changes, durable subscriptions, OAuth, local stdio servers, and
MCP resources/prompts require later decisions. VM or container isolation is not
part of this trusted remote-integration contract.

## References

- [Official TypeScript client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)
- [Official TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [MCP pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
- [MCP tool annotation risk vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
