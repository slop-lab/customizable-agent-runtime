import type { RecordEntry, ToolDescription, ToolResult } from "./contracts.js";

export type JsonObject = Readonly<Record<string, unknown>>;

export type NormalizedContent =
  | { readonly type: "text"; readonly role: "system" | "user" | "assistant"; readonly text: string }
  | { readonly type: "tool-call"; readonly callId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly callId: string; readonly output: unknown; readonly isError: boolean }
  | { readonly type: "provider-native"; readonly provider: string; readonly value: unknown };

export type CapabilityValue =
  | { readonly supported: false; readonly reason?: string }
  | { readonly supported: true; readonly constraints?: JsonObject };

export interface ProviderCapabilitiesV1 {
  readonly version: 1;
  readonly values: Readonly<Record<string, CapabilityValue>>;
}

export interface ProviderProfile {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialHandle: string;
  readonly requestDefaults?: JsonObject;
}

export interface ProviderSemanticEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}

export interface ProviderTurn {
  readonly content: readonly NormalizedContent[];
  readonly finishReason?: string;
  readonly usage?: JsonObject;
  readonly normalizedUsage?: NormalizedUsageV1;
  readonly providerResponseId?: string;
}

export interface NormalizedUsageV1 {
  readonly version: 1;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export interface ModelInvocationRequest {
  readonly attemptId: string;
  readonly context: ContextProjection;
  readonly tools: readonly ToolDescription[];
  readonly signal: AbortSignal;
  recordRequest(payload: unknown): void;
  recordEvent(eventType: string, payload: unknown): void;
}

export interface ModelProvider {
  readonly id: string;
  readonly profile: ProviderProfile;
  readonly capabilities: ProviderCapabilitiesV1;
  invoke(request: ModelInvocationRequest): Promise<ProviderTurn>;
}

export interface ModelAttemptResult extends ProviderTurn {
  readonly attemptId: string;
}

export class ProviderInvocationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean,
    readonly details?: JsonObject) { super(message); this.name = "ProviderInvocationError"; }
}

export class ModelAttemptFailure extends Error {
  constructor(readonly attemptId: string, readonly providerError: ProviderInvocationError) {
    super(providerError.message); this.name = "ModelAttemptFailure";
  }
}

export interface ContextProjection {
  readonly id: string;
  readonly runId: string;
  readonly projectorId: string;
  readonly projectorVersion: string;
  readonly includedRecordIds: readonly string[];
  readonly excludedRecords: readonly { readonly recordId: string; readonly reason: string }[];
  readonly content: readonly NormalizedContent[];
  readonly requestHash?: string;
  readonly createdAt: string;
}

export type ModelAttemptStatus = "running" | "completed" | "failed" | "cancelled" | "abandoned";

export interface ModelAttempt {
  readonly id: string;
  readonly runId: string;
  readonly operationId: string;
  readonly attemptNumber: number;
  readonly previousAttemptId?: string;
  readonly retryOfAttemptId?: string;
  readonly contextProjectionId: string;
  readonly requestArtifactId?: string;
  readonly eventArtifactId?: string;
  readonly providerProfile: ProviderProfile;
  readonly capabilities: ProviderCapabilitiesV1;
  readonly status: ModelAttemptStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly finishReason?: string;
  readonly usage?: JsonObject;
  readonly normalizedUsage?: NormalizedUsageV1;
  readonly providerResponseId?: string;
  readonly error?: JsonObject;
  readonly retryDecision?: JsonObject;
}

export interface DriverContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  records(): readonly RecordEntry[];
  tools(): readonly ToolDescription[];
  invokeModel(options?: { readonly retryOfAttemptId?: string }): Promise<ModelAttemptResult>;
  recordRetryDecision(attemptId: string, decision: JsonObject): Promise<void>;
  append(content: NormalizedContent): Promise<void>;
  dispatch(call: Extract<NormalizedContent, { type: "tool-call" }>): Promise<ToolResult>;
}

export interface AgentDriver {
  readonly id: string;
  readonly version: string;
  run(context: DriverContext): Promise<void>;
}
