import type { RecordEntry, ToolDescription, ToolResult } from "./contracts.js";

export type JsonObject = Readonly<Record<string, unknown>>;

export type NormalizedContent =
  | { readonly type: "text"; readonly text: string }
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
  readonly providerResponseId?: string;
}

export interface ModelInvocationRequest {
  readonly attemptId: string;
  readonly records: readonly RecordEntry[];
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

export interface DriverContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  records(): readonly RecordEntry[];
  tools(): readonly ToolDescription[];
  invokeModel(): Promise<ModelAttemptResult>;
  append(content: NormalizedContent): Promise<void>;
  dispatch(call: Extract<NormalizedContent, { type: "tool-call" }>): Promise<ToolResult>;
}

export interface AgentDriver {
  readonly id: string;
  readonly version: string;
  run(context: DriverContext): Promise<void>;
}
