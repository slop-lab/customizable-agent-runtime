import type { JsonObject } from "./agent-contracts.js";
import type { Tool, ToolMiddleware } from "./contracts.js";
import { RuntimeError } from "./errors.js";
import { canonicalJson, type ConfiguredPluginIdentity } from "./provenance.js";

export interface PluginManifestV1 {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly dependencies?: readonly string[];
  readonly configuration?: JsonObject;
}

export interface PluginHealth {
  readonly status: "ready" | "degraded";
  readonly message?: string;
}

export interface PluginRegistrar {
  registerTool(tool: Tool): void;
  registerToolMiddleware(middleware: ToolMiddleware): void;
}

export interface RuntimePlugin {
  readonly manifest: PluginManifestV1;
  setup(registrar: PluginRegistrar): void | Promise<void>;
  start?(): void | Promise<void>;
  health?(signal: AbortSignal): PluginHealth | Promise<PluginHealth>;
  stop?(): void;
}

export interface PluginInspection {
  readonly id: string;
  readonly version: string;
  readonly dependencies: readonly string[];
  readonly state: "ready" | "stopped";
  readonly health: PluginHealth | { readonly status: "failed"; readonly message: string };
}

export interface PluginHostOptions {
  readonly healthTimeoutMs?: number;
}

interface PluginEntry {
  readonly plugin: RuntimePlugin;
  readonly identity: ConfiguredPluginIdentity;
  state: PluginInspection["state"];
}

export class PluginHost {
  readonly #entries: readonly PluginEntry[];
  readonly #tools: readonly Tool[];
  readonly #middleware: readonly ToolMiddleware[];
  readonly #healthTimeoutMs: number;
  #closed = false;

  private constructor(entries: readonly PluginEntry[], tools: readonly Tool[], middleware: readonly ToolMiddleware[],
    options: PluginHostOptions) {
    this.#entries = entries;
    this.#tools = tools;
    this.#middleware = middleware;
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.#healthTimeoutMs) || this.#healthTimeoutMs < 1) {
      throw new RuntimeError("validation", "Plugin health timeout must be a positive integer");
    }
  }

  static async initialize(plugins: readonly RuntimePlugin[], options: PluginHostOptions = {}): Promise<PluginHost> {
    const ordered = orderPlugins(plugins);
    const entries: PluginEntry[] = [];
    const tools: Tool[] = [];
    const middleware: ToolMiddleware[] = [];
    const toolOwners = new Map<string, string>();
    try {
      for (const plugin of ordered) {
        const identity = identityFromManifest(plugin.manifest);
        const entry: PluginEntry = { plugin, identity, state: "stopped" };
        entries.push(entry);
        const stagedTools: Tool[] = [];
        const stagedMiddleware: ToolMiddleware[] = [];
        let accepting = true;
        const registrar: PluginRegistrar = {
          registerTool(tool) {
            if (!accepting) throw new RuntimeError("conflict", `Plugin registration phase ended: ${identity.id}`);
            validatePluginTool(identity.id, tool);
            if (stagedTools.some((candidate) => candidate.description.name === tool.description.name)) {
              throw new RuntimeError("conflict", `Duplicate plugin tool: ${tool.description.name}`);
            }
            stagedTools.push(tool);
          },
          registerToolMiddleware(value) {
            if (!accepting) throw new RuntimeError("conflict", `Plugin registration phase ended: ${identity.id}`);
            stagedMiddleware.push(value);
          },
        };
        try { await plugin.setup(registrar); }
        finally { accepting = false; }
        for (const tool of stagedTools) {
          const existing = toolOwners.get(tool.description.name);
          if (existing !== undefined) {
            throw new RuntimeError("conflict", `Plugin tool ${tool.description.name} is already registered by ${existing}`);
          }
          toolOwners.set(tool.description.name, identity.id);
          tools.push(tool);
        }
        middleware.push(...stagedMiddleware);
      }
      for (const entry of entries) {
        await entry.plugin.start?.();
        entry.state = "ready";
      }
      return new PluginHost(entries, tools, middleware, options);
    } catch (error) {
      stopEntries(entries);
      const message = error instanceof Error ? error.message : String(error);
      throw error instanceof RuntimeError ? error : new RuntimeError("internal", `Plugin initialization failed: ${message}`);
    }
  }

  tools(): readonly Tool[] { return this.#tools; }
  middleware(): readonly ToolMiddleware[] { return this.#middleware; }
  identities(): readonly ConfiguredPluginIdentity[] { return this.#entries.map((entry) => entry.identity); }

  async inspect(): Promise<readonly PluginInspection[]> {
    return Promise.all(this.#entries.map(async (entry): Promise<PluginInspection> => {
      if (entry.state === "stopped" || entry.plugin.health === undefined) {
        return { id: entry.identity.id, version: entry.identity.version,
          dependencies: entry.identity.dependencies, state: entry.state,
          health: entry.state === "ready" ? { status: "ready" } : { status: "failed", message: "Plugin is stopped" } };
      }
      try {
        const health = await inspectHealth(entry.plugin.health.bind(entry.plugin), this.#healthTimeoutMs);
        if (health.status !== "ready" && health.status !== "degraded") throw new Error("Invalid plugin health status");
        return { id: entry.identity.id, version: entry.identity.version,
          dependencies: entry.identity.dependencies, state: entry.state, health };
      } catch (error) {
        return { id: entry.identity.id, version: entry.identity.version,
          dependencies: entry.identity.dependencies, state: entry.state,
          health: { status: "failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }));
  }

  close(): readonly Error[] {
    if (this.#closed) return [];
    this.#closed = true;
    return stopEntries(this.#entries);
  }
}

function identityFromManifest(manifest: PluginManifestV1): ConfiguredPluginIdentity {
  if (manifest.apiVersion !== 1 || !qualifiedId(manifest.id) || !nonEmpty(manifest.version)) {
    throw new RuntimeError("validation", "Invalid plugin manifest identity");
  }
  const dependencies = [...(manifest.dependencies ?? [])];
  if (dependencies.some((dependency) => !qualifiedId(dependency)) || new Set(dependencies).size !== dependencies.length ||
    dependencies.includes(manifest.id)) {
    throw new RuntimeError("validation", `Invalid plugin dependencies: ${manifest.id}`);
  }
  const configuration = manifest.configuration === undefined
    ? undefined : JSON.parse(canonicalJson(manifest.configuration)) as JsonObject;
  return { id: manifest.id, version: manifest.version, dependencies: dependencies.sort(compareStrings),
    ...(configuration === undefined ? {} : { configuration }) };
}

function orderPlugins(plugins: readonly RuntimePlugin[]): readonly RuntimePlugin[] {
  const byId = new Map<string, RuntimePlugin>();
  const identities = new Map<string, ConfiguredPluginIdentity>();
  for (const plugin of plugins) {
    const identity = identityFromManifest(plugin.manifest);
    if (byId.has(identity.id)) throw new RuntimeError("conflict", `Duplicate plugin: ${identity.id}`);
    byId.set(identity.id, plugin);
    identities.set(identity.id, identity);
  }
  for (const identity of identities.values()) {
    for (const dependency of identity.dependencies) {
      if (!byId.has(dependency)) {
        throw new RuntimeError("validation", `Plugin ${identity.id} requires missing plugin ${dependency}`);
      }
    }
  }
  const remaining = new Map([...identities].map(([id, identity]) => [id, new Set(identity.dependencies)]));
  const ordered: RuntimePlugin[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id).sort(compareStrings);
    if (ready.length === 0) {
      throw new RuntimeError("conflict", `Plugin dependency cycle: ${[...remaining.keys()].sort(compareStrings).join(", ")}`);
    }
    for (const id of ready) {
      ordered.push(byId.get(id)!);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

function validatePluginTool(pluginId: string, tool: Tool): void {
  const name = tool.description.name;
  if (!name.startsWith(`${pluginId}.`) || !qualifiedId(name)) {
    throw new RuntimeError("validation", `Plugin tool must use namespace ${pluginId}: ${name}`);
  }
}

function stopEntries(entries: readonly PluginEntry[]): readonly Error[] {
  const errors: Error[] = [];
  for (const entry of [...entries].reverse()) {
    entry.state = "stopped";
    try { entry.plugin.stop?.(); }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  return errors;
}

async function inspectHealth(check: (signal: AbortSignal) => PluginHealth | Promise<PluginHealth>,
  timeoutMs: number): Promise<PluginHealth> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Plugin health check timed out after ${timeoutMs}ms`));
      reject(controller.signal.reason);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve(check(controller.signal)), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function qualifiedId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
}
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
