import { createHash } from "node:crypto";
import type { JsonObject, ProviderCapabilitiesV1, ProviderProfile } from "./agent-contracts.js";
import type { ToolDescription } from "./contracts.js";

export interface ComponentIdentity {
  readonly id: string;
  readonly version: string;
}

export interface RuntimeComponentIdentity extends ComponentIdentity {
  readonly sourceRevision?: string;
}

export interface ConfiguredComponentIdentity extends ComponentIdentity {
  readonly configuration?: JsonObject;
}

export interface RunProvenanceEnvironment {
  readonly runtime: RuntimeComponentIdentity;
  readonly workspace?: JsonObject;
  readonly worker?: ConfiguredComponentIdentity;
  readonly security: {
    readonly profile: string;
    readonly redactionPolicy: ComponentIdentity;
  };
}

export interface RunProvenanceManifestV1 {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly runtime: RuntimeComponentIdentity;
  readonly driver: ConfiguredComponentIdentity;
  readonly provider: {
    readonly adapter: ComponentIdentity;
    readonly profile: ProviderProfile;
    readonly capabilities: ProviderCapabilitiesV1;
    readonly transport?: ComponentIdentity;
  };
  readonly contextProjector: ComponentIdentity;
  readonly tools: readonly {
    readonly id: string;
    readonly version: string;
    readonly inputSchemaHash: string;
  }[];
  readonly workspace: {
    readonly handle: string;
    readonly identity?: JsonObject;
  };
  readonly worker?: ConfiguredComponentIdentity;
  readonly security: RunProvenanceEnvironment["security"];
}

export interface StoredRunProvenance {
  readonly runId: string;
  readonly manifest: RunProvenanceManifestV1;
  readonly manifestHash: string;
  readonly createdAt: string;
}

export interface CreateRunProvenanceInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly environment: RunProvenanceEnvironment;
  readonly workspaceHandle: string;
  readonly driver: ConfiguredComponentIdentity;
  readonly provider: {
    readonly id: string;
    readonly version?: string;
    readonly profile: ProviderProfile;
    readonly capabilities: ProviderCapabilitiesV1;
    readonly transport?: ComponentIdentity;
  };
  readonly contextProjector: ComponentIdentity;
  readonly tools: readonly ToolDescription[];
  readonly redact: (value: unknown) => unknown;
}

export function createRunProvenance(input: CreateRunProvenanceInput): StoredRunProvenance {
  const manifest = redacted<RunProvenanceManifestV1>({
    version: 1,
    runId: input.runId,
    createdAt: input.createdAt,
    runtime: input.environment.runtime,
    driver: input.driver,
    provider: {
      adapter: { id: input.provider.id, version: input.provider.version ?? "unversioned" },
      profile: input.provider.profile,
      capabilities: input.provider.capabilities,
      ...(input.provider.transport === undefined ? {} : { transport: input.provider.transport }),
    },
    contextProjector: input.contextProjector,
    tools: input.tools.map((tool) => ({
      id: tool.name,
      version: tool.version ?? "unversioned",
      inputSchemaHash: hashCanonicalJson(tool.inputSchema ?? {}),
    })).sort((left, right) => compareStrings(left.id, right.id)),
    workspace: {
      handle: input.workspaceHandle,
      ...(input.environment.workspace === undefined
        ? {}
        : { identity: input.environment.workspace }),
    },
    ...(input.environment.worker === undefined
      ? {}
      : { worker: input.environment.worker }),
    security: input.environment.security,
  }, input.redact);
  return {
    runId: input.runId,
    manifest,
    manifestHash: hashCanonicalJson(manifest),
    createdAt: input.createdAt,
  };
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Canonical JSON does not support circular values");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => item === undefined ? "null" : serialize(item, seen)).join(",")}]`;
    }
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) =>
      compareStrings(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function redacted<T>(value: T, redact: (value: unknown) => unknown): T {
  return redact(value) as T;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
