import type {
  JsonObject, ModelInvocationRequest, ModelProvider, NormalizedContent, NormalizedUsageV1, ProviderCapabilitiesV1,
  ProviderProfile, ProviderTurn,
} from "@car/core";
import { ProviderInvocationError } from "@car/core";
import type { CredentialResolver } from "./credentials.js";
import { parseSseJson } from "./sse.js";

export { parseSseJson } from "./sse.js";

export interface GoogleInteractionsTransport {
  stream(body: JsonObject, signal: AbortSignal): AsyncIterable<unknown>;
}

export class GoogleFetchInteractionsTransport implements GoogleInteractionsTransport {
  constructor(
    private readonly endpoint: string,
    private readonly credentialHandle: string,
    private readonly credentials: CredentialResolver,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async *stream(body: JsonObject, signal: AbortSignal): AsyncIterable<unknown> {
    const separator = this.endpoint.includes("?") ? "&" : "?";
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.endpoint}${separator}alt=sse`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": this.credentials.resolve(this.credentialHandle) },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderInvocationError("provider.cancelled", "Google request cancelled", false);
      throw new ProviderInvocationError("transport.network", error instanceof Error ? error.message : String(error), true);
    }
    if (!response.ok) {
      const responseText = await response.text();
      const retryable = response.status >= 500;
      throw new ProviderInvocationError(`google.http.${response.status}`,
        `Google Interactions request failed (${response.status}): ${safeErrorMessage(responseText)}`, retryable,
        { status: response.status });
    }
    if (!response.body) throw new ProviderInvocationError("transport.empty", "Google response has no stream body", true);
    try {
      yield* parseSseJson(response.body, signal, { invalidJson: (_value, error) =>
        new ProviderInvocationError("google.invalid-json",
          `Invalid Google event JSON: ${error instanceof Error ? error.message : String(error)}`, false) });
    } catch (error) {
      if (error instanceof ProviderInvocationError) throw error;
      if (signal.aborted) throw new ProviderInvocationError("provider.cancelled", "Google request cancelled", false);
      throw new ProviderInvocationError("transport.network", error instanceof Error ? error.message : String(error), true);
    }
  }
}

export interface GoogleProviderOptions {
  readonly model: string;
  readonly endpoint: string;
  readonly credentialHandle: string;
  readonly transport: GoogleInteractionsTransport;
}

export class GoogleInteractionsProvider implements ModelProvider {
  readonly id = "google.interactions";
  readonly profile: ProviderProfile;
  readonly capabilities: ProviderCapabilitiesV1 = { version: 1, values: {
    "core.streaming.text": { supported: true },
    "core.tools.calls": { supported: true, constraints: { parallel: true } },
    "core.cancellation": { supported: true },
    "core.provider-native": { supported: true },
    "google.interactions.stateless": { supported: true },
  } };

  constructor(private readonly options: GoogleProviderOptions) {
    this.profile = { id: "google-ai-studio", provider: "google", model: options.model,
      endpoint: options.endpoint, credentialHandle: options.credentialHandle };
  }

  async invoke(request: ModelInvocationRequest): Promise<ProviderTurn> {
    const body = { model: this.options.model, store: false, stream: true,
      input: projectGoogleInput(request.context.content), tools: request.tools.map((tool) => ({
        type: "function", name: tool.name, description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", additionalProperties: true },
      })) } as const;
    request.recordRequest(body);
    const steps = new Map<number, Record<string, unknown>>();
    let completed: Record<string, unknown> | undefined;
    for await (const payload of this.options.transport.stream(body, request.signal)) {
      const event = asObject(payload);
      const eventType = stringValue(event.event_type) ?? "unknown";
      request.recordEvent(eventType, payload);
      applyStreamEvent(steps, event);
      if (eventType === "interaction.completed") completed = asObjectOrUndefined(event.interaction);
    }
    if (!completed) throw new ProviderInvocationError("google.incomplete-stream",
      "Google stream ended without an interaction.completed event", true);
    const finalSteps = (Array.isArray(completed?.steps) ? completed.steps.map(asObject) : [...steps.values()])
      .map(finalizeStreamStep);
    const content: NormalizedContent[] = [];
    for (const step of finalSteps) {
      content.push(...normalizeGoogleStep(step));
      content.push({ type: "provider-native", provider: "google.interactions", value: step });
    }
    const usage = asObjectOrUndefined(completed?.usage);
    return { content, finishReason: stringValue(completed?.status) ?? "completed",
      ...(usage ? { usage, normalizedUsage: normalizeGoogleUsage(usage) } : {}),
      ...(stringValue(completed?.id) ? { providerResponseId: stringValue(completed!.id)! } : {}) };
  }
}

export function normalizeGoogleUsage(usage: Readonly<Record<string, unknown>>): NormalizedUsageV1 {
  return compactUsage({ version: 1, inputTokens: numberValue(usage.total_input_tokens),
    outputTokens: numberValue(usage.total_output_tokens), reasoningTokens: numberValue(usage.total_thought_tokens),
    cacheReadTokens: numberValue(usage.total_cached_tokens), totalTokens: numberValue(usage.total_tokens) });
}

function projectGoogleInput(content: readonly NormalizedContent[]): unknown[] {
  const hasNativeGoogleSteps = content.some((value) => value.type === "provider-native" && value.provider === "google.interactions");
  const toolNames = new Map<string, string>();
  for (const item of content) {
    if (item.type === "tool-call") toolNames.set(item.callId, item.toolName);
    if (item.type === "provider-native" && item.provider === "google.interactions") {
      const step = asObject(item.value);
      if (step.type === "function_call" && typeof step.id === "string" && typeof step.name === "string") {
        toolNames.set(step.id, step.name);
      }
    }
  }
  const input: unknown[] = [];
  for (const item of content) {
    if (item.type === "provider-native" && item.provider === "google.interactions") { input.push(item.value); continue; }
    if (item.type === "text" && item.role === "user") {
      input.push({ type: "user_input", content: [{ type: "text", text: item.text }] }); continue;
    }
    if (item.type === "text" && item.role === "system") {
      input.push({ type: "user_input", content: [{ type: "text", text: item.text }] }); continue;
    }
    if (item.type === "text" && item.role === "assistant" && !hasNativeGoogleSteps) {
      input.push({ type: "model_output", content: [{ type: "text", text: item.text }] }); continue;
    }
    if (item.type === "tool-call" && !hasNativeGoogleSteps) {
      input.push({ type: "function_call", id: item.callId, name: item.toolName, arguments: item.input }); continue;
    }
    if (item.type === "tool-result") input.push({ type: "function_result", name: toolNames.get(item.callId), call_id: item.callId,
      is_error: item.isError, result: [{ type: "text", text: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }] });
  }
  return input;
}

function applyStreamEvent(steps: Map<number, Record<string, unknown>>, event: Record<string, unknown>): void {
  const index = typeof event.index === "number" ? event.index : steps.size;
  if (event.event_type === "step.start") { steps.set(index, structuredClone(asObject(event.step))); return; }
  if (event.event_type !== "step.delta") return;
  const step = steps.get(index) ?? {};
  const delta = asObject(event.delta);
  const type = stringValue(delta.type);
  if (type === "text" && typeof delta.text === "string") {
    const content = Array.isArray(step.content) ? step.content as Record<string, unknown>[] : [];
    const last = content.at(-1);
    if (last?.type === "text") last.text = `${stringValue(last.text) ?? ""}${delta.text}`;
    else content.push({ type: "text", text: delta.text });
    step.type ??= "model_output"; step.content = content;
  } else if (type === "arguments" || type === "arguments_delta") {
    const partial = stringValue(delta.partial_arguments) ?? stringValue(delta.arguments_delta) ?? stringValue(delta.arguments) ?? "";
    step.__partialArguments = `${stringValue(step.__partialArguments) ?? ""}${partial}`;
  } else if (type === "thought_signature" && typeof delta.signature === "string") {
    step.signature = delta.signature;
  }
  steps.set(index, step);
}

function finalizeStreamStep(value: Record<string, unknown>): Record<string, unknown> {
  const step = structuredClone(value);
  if (step.type === "function_call" && typeof step.__partialArguments === "string" && step.__partialArguments.length > 0) {
    step.arguments = parseJson(step.__partialArguments);
  }
  delete step.__partialArguments;
  return step;
}

function normalizeGoogleStep(step: Record<string, unknown>): NormalizedContent[] {
  if (step.type === "model_output" && Array.isArray(step.content)) return step.content.flatMap((part) => {
    const value = asObject(part); return value.type === "text" && typeof value.text === "string"
      ? [{ type: "text" as const, role: "assistant" as const, text: value.text }] : [];
  });
  if (step.type === "function_call") {
    let input = step.arguments;
    if (input === undefined && typeof step.__partialArguments === "string") input = parseJson(step.__partialArguments);
    return typeof step.id === "string" && typeof step.name === "string"
      ? [{ type: "tool-call", callId: step.id, toolName: step.name, input }] : [];
  }
  return [];
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch (error) { throw new ProviderInvocationError("google.invalid-json", `Invalid Google event JSON: ${error instanceof Error ? error.message : String(error)}`, false); }
}
function safeErrorMessage(value: string): string {
  try { const parsed = asObject(JSON.parse(value)); const error = asObject(parsed.error); return stringValue(error.message) ?? `HTTP error`; }
  catch { return value.slice(0, 500); }
}
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function asObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function compactUsage(value: Readonly<Record<string, number | undefined>> & { readonly version: 1 }): NormalizedUsageV1 {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as NormalizedUsageV1;
}
