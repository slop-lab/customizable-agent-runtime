import type { WorkspaceHandle } from "./worker.js";
import type { ArtifactIngressDescriptorV1, ArtifactReference } from "./artifacts.js";
import type { StoredWorkerExecutionManifest } from "./provenance.js";
import type { WorkerLease } from "./worker.js";

export type Id = string;

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolCallContent {
  readonly type: "tool-call";
  readonly callId: Id;
  readonly toolName: string;
  readonly input: unknown;
}

export type ModelContent = TextContent | ToolCallContent;

export interface ModelRequest {
  readonly sessionId: Id;
  readonly runId: Id;
  readonly records: readonly RecordEntry[];
  readonly tools: readonly ToolDescription[];
  readonly signal: AbortSignal;
}

export interface ModelChunk {
  readonly content: ModelContent;
  readonly native?: Readonly<Record<string, unknown>>;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly parallelToolCalls: boolean;
  readonly cancellation: boolean;
}

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

export interface ToolDescription {
  readonly name: string;
  readonly version?: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly validateInput?: (input: unknown) => string | undefined;
}

export interface ToolContext {
  readonly sessionId: Id;
  readonly runId: Id;
  readonly operationId: Id;
  readonly workspace: WorkspaceHandle;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly output: string;
  readonly isError?: boolean;
  readonly artifactIngress?: ArtifactIngressDescriptorV1;
  readonly artifacts?: readonly ArtifactReference[];
  readonly workerLease?: WorkerLease;
  readonly workerExecutionManifest?: StoredWorkerExecutionManifest;
}

export interface Tool {
  readonly description: ToolDescription;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ToolMiddlewareDecision =
  | { readonly type: "continue" }
  | { readonly type: "replace"; readonly input: unknown }
  | { readonly type: "deny"; readonly message: string }
  | { readonly type: "suspend"; readonly reason: string }
  | { readonly type: "substitute"; readonly result: ToolResult }
  | { readonly type: "redirect"; readonly toolName: string; readonly input: unknown };

export interface ToolMiddleware {
  before(
    tool: ToolDescription,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolMiddlewareDecision>;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface Session {
  readonly id: Id;
  readonly createdAt: string;
}

export interface SessionSummary extends Session {
  readonly updatedAt: string;
  readonly firstUserMessage?: string;
  readonly recordCount: number;
  readonly runCount: number;
  readonly runStatusCounts: Readonly<Record<RunStatus, number>>;
}

export interface Run {
  readonly id: Id;
  readonly sessionId: Id;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly error?: string;
}

export interface RunSummary extends Run {
  readonly modelRequestCount: number;
  readonly retryCount: number;
  readonly toolOperationCount: number;
  readonly providerModels: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
}

export type RecordKind = "user" | "assistant" | "tool-call" | "tool-result" | "provider-native" | "error";

export interface RecordEntry {
  readonly id: Id;
  readonly sessionId: Id;
  readonly runId: Id;
  readonly kind: RecordKind;
  readonly data: unknown;
  readonly createdAt: string;
}

export interface RuntimeEvent {
  readonly id: Id;
  readonly type:
    | "session.created"
    | "run.started"
    | "record.appended"
    | "run.finished"
    | "operation.started"
    | "operation.finished"
    | "operation.recovered";
  readonly occurredAt: string;
  readonly data: unknown;
}
