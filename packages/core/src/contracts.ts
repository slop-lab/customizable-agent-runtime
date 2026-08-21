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
  readonly description: string;
}

export interface ToolContext {
  readonly sessionId: Id;
  readonly runId: Id;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly output: string;
  readonly isError?: boolean;
}

export interface Tool {
  readonly description: ToolDescription;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ToolMiddlewareDecision =
  | { readonly type: "continue" }
  | { readonly type: "substitute"; readonly result: ToolResult };

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

export interface Run {
  readonly id: Id;
  readonly sessionId: Id;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly error?: string;
}

export type RecordKind = "user" | "assistant" | "tool-call" | "tool-result" | "error";

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
  readonly type: "session.created" | "run.started" | "record.appended" | "run.finished";
  readonly occurredAt: string;
  readonly data: unknown;
}
