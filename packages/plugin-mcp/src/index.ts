import type { JsonObject, RuntimePlugin, Tool as RuntimeTool } from "@car/core";
import { canonicalJson, RuntimeError } from "@car/core";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type Tool as SdkTool,
} from "@modelcontextprotocol/client";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_LIST_PAGES = 8;
const DEFAULT_MAXIMUM_TOOLS = 32;
const DEFAULT_MAXIMUM_SCHEMA_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_RESULT_BYTES = 64 * 1024;

export interface CredentialResolver {
  resolve(handle: string): string;
}

export interface McpConnectionIdentity {
  readonly name?: string;
  readonly version?: string;
  readonly protocolEra?: string;
}

export type McpToolDefinition = SdkTool;

export interface McpCallResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface McpRemoteClient {
  connect(signal: AbortSignal, timeoutMs: number): Promise<McpConnectionIdentity>;
  listTools(signal: AbortSignal, timeoutMs: number): Promise<readonly McpToolDefinition[]>;
  callTool(tool: McpToolDefinition, input: JsonObject, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult>;
  ping(signal: AbortSignal, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface StreamableHttpMcpClientOptions {
  readonly endpoint: string;
  readonly credentialHandle?: string;
  readonly credentials?: CredentialResolver;
  readonly maximumListPages?: number;
  readonly probeTimeoutMs?: number;
  readonly fetchImplementation?: FetchLike;
  /** Test and compatibility escape hatch. Production callers should retain the default `auto` mode. */
  readonly versionNegotiation?: "auto" | "legacy";
}

export class StreamableHttpMcpClient implements McpRemoteClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  #closePromise: Promise<void> | undefined;

  constructor(options: StreamableHttpMcpClientOptions) {
    const endpoint = normalizeEndpoint(options.endpoint);
    const maximumListPages = boundedInteger(options.maximumListPages, DEFAULT_MAXIMUM_LIST_PAGES, 1, 64,
      "MCP maximum list pages");
    const probeTimeoutMs = boundedInteger(options.probeTimeoutMs, 5_000, 1, 60_000, "MCP probe timeout");
    if (options.credentialHandle !== undefined && !nonEmpty(options.credentialHandle)) {
      throw new RuntimeError("validation", "MCP credential handle must not be empty");
    }
    if (options.credentialHandle !== undefined && options.credentials === undefined) {
      throw new RuntimeError("validation", "MCP credentials resolver is required when a credential handle is set");
    }
    if (options.credentials !== undefined && options.credentialHandle === undefined) {
      throw new RuntimeError("validation", "MCP credential handle is required when a credentials resolver is set");
    }

    this.#client = new Client({ name: "car", version: "1" }, {
      capabilities: {},
      enforceStrictCapabilities: true,
      inputRequired: { autoFulfill: false },
      listMaxPages: maximumListPages,
      defaultCacheTtlMs: 0,
      versionNegotiation: options.versionNegotiation === "legacy"
        ? { mode: "legacy" }
        : { mode: "auto", probe: { timeoutMs: probeTimeoutMs, maxRetries: 0 } },
    });
    const credentialHandle = options.credentialHandle;
    const credentials = options.credentials;
    this.#transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      ...(credentialHandle === undefined || credentials === undefined ? {} : {
        authProvider: { token: async () => resolveCredential(credentials, credentialHandle) },
      }),
      ...(options.fetchImplementation === undefined ? {} : { fetch: options.fetchImplementation }),
      onInsufficientScope: "throw",
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
      },
    });
  }

  async connect(signal: AbortSignal, timeoutMs: number): Promise<McpConnectionIdentity> {
    await this.#client.connect(this.#transport, requestOptions(signal, timeoutMs));
    const server = this.#client.getServerVersion();
    const era = this.#client.getProtocolEra();
    return {
      ...(server?.name === undefined ? {} : { name: server.name }),
      ...(server?.version === undefined ? {} : { version: server.version }),
      ...(era === undefined ? {} : { protocolEra: String(era) }),
    };
  }

  async listTools(signal: AbortSignal, timeoutMs: number): Promise<readonly McpToolDefinition[]> {
    const result = await this.#client.listTools(undefined, {
      ...requestOptions(signal, timeoutMs),
      cacheMode: "refresh",
    });
    return result.tools;
  }

  async callTool(tool: McpToolDefinition, input: JsonObject, signal: AbortSignal,
    timeoutMs: number): Promise<McpCallResult> {
    const result: CallToolResult = await this.#client.callTool({ name: tool.name, arguments: input }, {
      ...requestOptions(signal, timeoutMs),
      toolDefinition: tool,
    });
    return {
      content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  }

  async ping(signal: AbortSignal, timeoutMs: number): Promise<void> {
    await this.#client.ping(requestOptions(signal, timeoutMs));
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const errors: Error[] = [];
    try { await this.#transport.terminateSession(); }
    catch (error) { errors.push(asError(error)); }
    try { await this.#client.close(); }
    catch (error) { errors.push(asError(error)); }
    if (errors.length > 0) throw new AggregateError(errors, "MCP client cleanup failed");
  }
}

export interface McpPluginOptions {
  readonly serverId: string;
  readonly endpoint: string;
  readonly allowedTools: readonly string[];
  readonly client: McpRemoteClient;
  readonly credentialHandle?: string;
  readonly requireReadOnly?: boolean;
  readonly connectionTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maximumListPages?: number;
  readonly maximumTools?: number;
  readonly maximumSchemaBytes?: number;
  readonly maximumResultBytes?: number;
}

export interface StreamableHttpMcpPluginOptions extends Omit<McpPluginOptions, "client"> {
  readonly credentials?: CredentialResolver;
  readonly probeTimeoutMs?: number;
  readonly fetchImplementation?: FetchLike;
}

export function createStreamableHttpMcpPlugin(options: StreamableHttpMcpPluginOptions): RuntimePlugin {
  const client = new StreamableHttpMcpClient({
    endpoint: options.endpoint,
    ...(options.credentialHandle === undefined ? {} : { credentialHandle: options.credentialHandle }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.maximumListPages === undefined ? {} : { maximumListPages: options.maximumListPages }),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
  });
  return createMcpPlugin({ ...options, client });
}

export function createMcpPlugin(options: McpPluginOptions): RuntimePlugin {
  const configuration = validatePluginOptions(options);
  const lifecycle = new AbortController();
  let identity: McpConnectionIdentity = {};

  return {
    manifest: {
      apiVersion: 1,
      id: configuration.pluginId,
      version: "1",
      configuration: configuration.manifest,
    },
    async setup(registrar) {
      identity = await options.client.connect(lifecycle.signal, configuration.connectionTimeoutMs);
      const listed = await options.client.listTools(lifecycle.signal, configuration.connectionTimeoutMs);
      const selected = selectTools(listed, configuration);
      for (const tool of selected) registrar.registerTool(runtimeTool(tool, options.client, configuration, lifecycle.signal));
    },
    async health(signal) {
      await options.client.ping(AbortSignal.any([signal, lifecycle.signal]), configuration.connectionTimeoutMs);
      const server = [boundedText(identity.name, 128), boundedText(identity.version, 64)].filter(Boolean).join("@");
      return { status: "ready", ...(server ? { message: `Connected to ${server}` } : {}) };
    },
    async stop() {
      lifecycle.abort(new Error("MCP plugin stopped"));
      await options.client.close();
    },
  };
}

interface ValidatedPluginOptions {
  readonly pluginId: string;
  readonly allowedTools: readonly string[];
  readonly requireReadOnly: boolean;
  readonly connectionTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maximumListPages: number;
  readonly maximumTools: number;
  readonly maximumSchemaBytes: number;
  readonly maximumResultBytes: number;
  readonly manifest: JsonObject;
}

function validatePluginOptions(options: McpPluginOptions): ValidatedPluginOptions {
  const serverId = options.serverId.trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(serverId)) {
    throw new RuntimeError("validation", "MCP server ID must be a lowercase identifier");
  }
  const endpoint = normalizeEndpoint(options.endpoint);
  if (options.credentialHandle !== undefined && !nonEmpty(options.credentialHandle)) {
    throw new RuntimeError("validation", "MCP credential handle must not be empty");
  }
  const maximumTools = boundedInteger(options.maximumTools, DEFAULT_MAXIMUM_TOOLS, 1, 256, "MCP maximum tools");
  const maximumListPages = boundedInteger(options.maximumListPages, DEFAULT_MAXIMUM_LIST_PAGES, 1, 64,
    "MCP maximum list pages");
  const maximumSchemaBytes = boundedInteger(options.maximumSchemaBytes, DEFAULT_MAXIMUM_SCHEMA_BYTES, 1, 1024 * 1024,
    "MCP maximum schema bytes");
  const maximumResultBytes = boundedInteger(options.maximumResultBytes, DEFAULT_MAXIMUM_RESULT_BYTES, 1, 1024 * 1024,
    "MCP maximum result bytes");
  const connectionTimeoutMs = boundedInteger(options.connectionTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 1, 300_000,
    "MCP connection timeout");
  const callTimeoutMs = boundedInteger(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, 1, 300_000, "MCP call timeout");
  const allowedTools = options.allowedTools.map((name) => name.trim());
  if (allowedTools.length === 0 || allowedTools.length > maximumTools || allowedTools.some((name) => !name || name.length > 128)) {
    throw new RuntimeError("validation", `MCP allowlist must contain 1 through ${maximumTools} bounded tool names`);
  }
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new RuntimeError("validation", "MCP allowlist contains duplicate tool names");
  }
  allowedTools.sort(compareStrings);
  const requireReadOnly = options.requireReadOnly ?? true;
  const pluginId = `integration.mcp.${serverId}`;
  return {
    pluginId,
    allowedTools,
    requireReadOnly,
    connectionTimeoutMs,
    callTimeoutMs,
    maximumListPages,
    maximumTools,
    maximumSchemaBytes,
    maximumResultBytes,
    manifest: {
      endpoint,
      ...(options.credentialHandle === undefined ? {} : { credentialHandle: options.credentialHandle }),
      allowedTools,
      requireReadOnly,
      limits: { maximumListPages, maximumTools, maximumSchemaBytes, maximumResultBytes, connectionTimeoutMs,
        callTimeoutMs },
    },
  };
}

function selectTools(listed: readonly McpToolDefinition[], options: ValidatedPluginOptions): readonly McpToolDefinition[] {
  if (listed.length > options.maximumTools) {
    throw new RuntimeError("validation", `MCP server listed more than ${options.maximumTools} tools`);
  }
  const byName = new Map<string, McpToolDefinition>();
  for (const tool of listed) {
    if (!nonEmpty(tool.name) || tool.name.length > 128) throw new RuntimeError("validation", "MCP server listed an invalid tool name");
    if (byName.has(tool.name)) throw new RuntimeError("conflict", `MCP server listed duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  const localNames = new Set<string>();
  let schemaBytes = 0;
  return options.allowedTools.map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new RuntimeError("validation", `MCP allowlisted tool was not listed by the server: ${name}`);
    if (options.requireReadOnly && tool.annotations?.readOnlyHint !== true) {
      throw new RuntimeError("validation", `MCP tool is not declared read-only: ${name}`);
    }
    if (!plainObject(tool.inputSchema)) throw new RuntimeError("validation", `MCP tool has an invalid input schema: ${name}`);
    let serialized: string;
    try { serialized = canonicalJson(tool.inputSchema); }
    catch { throw new RuntimeError("validation", `MCP tool has a non-JSON input schema: ${name}`); }
    schemaBytes += Buffer.byteLength(serialized);
    if (schemaBytes > options.maximumSchemaBytes) {
      throw new RuntimeError("validation", `MCP tool schemas exceeded ${options.maximumSchemaBytes} bytes`);
    }
    const localName = `${options.pluginId}.${canonicalToolName(name)}`;
    if (localNames.has(localName)) throw new RuntimeError("conflict", `MCP tool name collision after normalization: ${name}`);
    localNames.add(localName);
    return tool;
  });
}

function runtimeTool(tool: McpToolDefinition, client: McpRemoteClient, options: ValidatedPluginOptions,
  lifecycleSignal: AbortSignal): RuntimeTool {
  const localName = `${options.pluginId}.${canonicalToolName(tool.name)}`;
  const remoteDescription = boundedText(tool.description, 1_000);
  return {
    description: {
      name: localName,
      version: "1",
      description: `Call the allowlisted MCP tool ${tool.name}.${remoteDescription ? ` ${remoteDescription}` : ""}`,
      inputSchema: tool.inputSchema,
      validateInput: (input) => plainObject(input) ? undefined : "Expected a JSON object.",
    },
    async execute(input, context) {
      const signal = AbortSignal.any([context.signal, lifecycleSignal]);
      try {
        const result = await client.callTool(tool, input as JsonObject, signal, options.callTimeoutMs);
        return {
          output: projectResult(result, options.maximumResultBytes),
          ...(result.isError === undefined ? {} : { isError: result.isError }),
        };
      } catch (error) {
        if (signal.aborted) throw new RuntimeError("cancelled", `MCP tool cancelled: ${tool.name}`);
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("internal", `MCP tool failed: ${boundedText(asError(error).message, 500) ?? "unknown error"}`);
      }
    },
  };
}

function projectResult(result: McpCallResult, maximumBytes: number): string {
  const parts = result.content.map(projectContent).filter((value) => value.length > 0);
  if (parts.length === 0 && result.structuredContent !== undefined) {
    try { parts.push(`Structured content:\n${canonicalJson(result.structuredContent)}`); }
    catch { throw new RuntimeError("internal", "MCP tool returned invalid structured content"); }
  }
  const output = parts.join("\n\n");
  if (Buffer.byteLength(output) > maximumBytes) {
    throw new RuntimeError("internal", `MCP tool result exceeded ${maximumBytes} bytes`);
  }
  return output;
}

function projectContent(value: unknown): string {
  if (!plainObject(value)) return "[Unsupported MCP content]";
  const type = typeof value.type === "string" ? value.type : "unknown";
  if (type === "text") return typeof value.text === "string" ? value.text : "[Invalid MCP text content]";
  if (type === "image" || type === "audio") {
    const mimeType = boundedText(value.mimeType, 128) ?? "unknown";
    const bytes = typeof value.data === "string" ? Math.floor(value.data.length * 3 / 4) : undefined;
    return `[MCP ${type} omitted: mimeType=${mimeType}${bytes === undefined ? "" : `, approximateBytes=${bytes}`}]`;
  }
  if (type === "resource_link") {
    const name = boundedText(value.name, 256) ?? "unnamed";
    const uri = boundedText(value.uri, 1_024) ?? "unknown";
    return `[MCP resource: ${name} (${uri})]`;
  }
  if (type === "resource") {
    const resource = plainObject(value.resource) ? value.resource : {};
    if (typeof resource.text === "string") return resource.text;
    const uri = boundedText(resource.uri, 1_024) ?? "unknown";
    return `[MCP binary resource omitted: ${uri}]`;
  }
  return `[Unsupported MCP content type: ${boundedText(type, 128) ?? "unknown"}]`;
}

function requestOptions(signal: AbortSignal, timeoutMs: number) {
  return { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs } as const;
}

function normalizeEndpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new RuntimeError("validation", "MCP endpoint must be an absolute HTTP or HTTPS URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password ||
    parsed.search || parsed.hash) {
    throw new RuntimeError("validation", "MCP endpoint must be HTTP(S) without credentials, query, or fragment");
  }
  return parsed.toString();
}

function canonicalToolName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!normalized) throw new RuntimeError("validation", `MCP tool name cannot be normalized: ${value}`);
  return /^[a-z]/.test(normalized) ? normalized : `tool-${normalized}`;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number,
  label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RuntimeError("validation", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}
function resolveCredential(credentials: CredentialResolver, handle: string): string {
  try {
    const value = credentials.resolve(handle);
    if (!nonEmpty(value)) throw new Error("empty credential");
    return value;
  } catch {
    throw new RuntimeError("internal", "MCP credential resolution failed");
  }
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
