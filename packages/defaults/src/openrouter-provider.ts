import type {
  JsonObject, ModelInvocationRequest, ModelProvider, NormalizedContent, NormalizedUsageV1, ProviderCapabilitiesV1,
  ProviderProfile, ProviderTurn,
} from "@car/core";
import { ProviderInvocationError } from "@car/core";
import type { CredentialResolver } from "./credentials.js";
import { parseSseJson } from "./sse.js";

export interface OpenRouterTransport {
  stream(body: JsonObject, signal: AbortSignal): AsyncIterable<unknown>;
}

export class OpenRouterFetchTransport implements OpenRouterTransport {
  constructor(
    private readonly endpoint: string,
    private readonly credentialHandle: string,
    private readonly credentials: CredentialResolver,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async *stream(body: JsonObject, signal: AbortSignal): AsyncIterable<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, { method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.credentials.resolve(this.credentialHandle)}`,
          "x-openrouter-title": "Customizable Agent Runtime" }, body: JSON.stringify(body) });
    } catch (error) {
      if (signal.aborted) throw new ProviderInvocationError("provider.cancelled", "OpenRouter request cancelled", false);
      throw new ProviderInvocationError("transport.network", error instanceof Error ? error.message : String(error), true);
    }
    if (!response.ok) {
      const responseText = await response.text();
      throw new ProviderInvocationError(`openrouter.http.${response.status}`,
        `OpenRouter request failed (${response.status}): ${safeErrorMessage(responseText)}`,
        response.status >= 500, { status: response.status });
    }
    if (!response.body) throw new ProviderInvocationError("transport.empty", "OpenRouter response has no stream body", true);
    try {
      yield* parseSseJson(response.body, signal, { invalidJson: (_value, error) =>
        new ProviderInvocationError("openrouter.invalid-json",
          `Invalid OpenRouter event JSON: ${error instanceof Error ? error.message : String(error)}`, false) });
    } catch (error) {
      if (error instanceof ProviderInvocationError) throw error;
      if (signal.aborted) throw new ProviderInvocationError("provider.cancelled", "OpenRouter request cancelled", false);
      throw new ProviderInvocationError("transport.network", error instanceof Error ? error.message : String(error), true);
    }
  }
}

export interface OpenRouterProviderOptions {
  readonly model: string;
  readonly endpoint: string;
  readonly credentialHandle: string;
  readonly transport: OpenRouterTransport;
}

export class OpenRouterChatProvider implements ModelProvider {
  readonly id = "openrouter.chat-completions";
  readonly profile: ProviderProfile;
  readonly capabilities: ProviderCapabilitiesV1 = { version: 1, values: {
    "core.streaming.text": { supported: true },
    "core.tools.calls": { supported: true, constraints: { parallel: true } },
    "core.cancellation": { supported: true },
    "core.provider-native": { supported: true },
    "openrouter.chat-completions": { supported: true },
  } };

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.profile = { id: "openrouter", provider: "openrouter", model: options.model,
      endpoint: options.endpoint, credentialHandle: options.credentialHandle };
  }

  async invoke(request: ModelInvocationRequest): Promise<ProviderTurn> {
    const body = { model: this.options.model, stream: true, messages: projectMessages(request.context.content),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name,
        description: tool.description, parameters: tool.inputSchema ?? { type: "object", additionalProperties: true } } })) };
    request.recordRequest(body);
    let responseId: string | undefined; let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined; let role = "assistant"; let text = "";
    let receivedChunk = false;
    const nativeDelta: Record<string, unknown> = {};
    const toolCalls = new Map<number, StreamToolCall>();
    for await (const payload of this.options.transport.stream(body, request.signal)) {
      receivedChunk = true;
      request.recordEvent("chat.completion.chunk", payload);
      const chunk = asObject(payload);
      const streamError = asObjectOrUndefined(chunk.error);
      if (streamError) throw streamInvocationError(streamError);
      if (typeof chunk.id === "string") responseId ??= chunk.id;
      const chunkUsage = asObjectOrUndefined(chunk.usage); if (chunkUsage) usage = chunkUsage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices.map(asObject) : [];
      const choice = choices.find((value) => value.index === 0) ?? choices[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = asObject(choice.delta);
      if (typeof delta.role === "string") role = delta.role;
      if (typeof delta.content === "string") text += delta.content;
      appendNativeDelta(nativeDelta, delta);
      if (Array.isArray(delta.tool_calls)) for (const value of delta.tool_calls) {
        appendToolCall(toolCalls, asObject(value));
      }
    }
    if (!receivedChunk) throw new ProviderInvocationError("openrouter.empty-stream",
      "OpenRouter stream completed without a semantic response chunk", true);
    const assembledCalls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
      if (!call.id || !call.name) throw new ProviderInvocationError("openrouter.invalid-tool-call",
        `Streamed tool call ${index} is missing an ID or function name`, false);
      return { id: call.id, type: call.type || "function", function: { name: call.name, arguments: call.arguments } };
    });
    const message = { role, content: text || null, ...nativeDelta,
      ...(assembledCalls.length === 0 ? {} : { tool_calls: assembledCalls }) };
    const content: NormalizedContent[] = [];
    if (text.length > 0) content.push({ type: "text", role: "assistant", text });
    for (const value of assembledCalls) {
      const call = asObject(value); const fn = asObject(call.function);
      if (typeof call.id === "string" && typeof fn.name === "string") content.push({ type: "tool-call",
        callId: call.id, toolName: fn.name, input: parseArguments(fn.arguments) });
    }
    content.push({ type: "provider-native", provider: "openrouter.chat", value: message });
    return { content, ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage ? { usage, normalizedUsage: normalizeOpenRouterUsage(usage) } : {}),
      ...(responseId === undefined ? {} : { providerResponseId: responseId }) };
  }
}

interface StreamToolCall { id: string; type: string; name: string; arguments: string }
function appendToolCall(calls: Map<number, StreamToolCall>, delta: Record<string, unknown>): void {
  const index = typeof delta.index === "number" && Number.isInteger(delta.index) ? delta.index : calls.size;
  const call = calls.get(index) ?? { id: "", type: "", name: "", arguments: "" };
  const fn = asObject(delta.function);
  if (typeof delta.id === "string") call.id += delta.id;
  if (typeof delta.type === "string") call.type = delta.type;
  if (typeof fn.name === "string") call.name += fn.name;
  if (typeof fn.arguments === "string") call.arguments += fn.arguments;
  calls.set(index, call);
}
function appendNativeDelta(target: Record<string, unknown>, delta: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(delta)) {
    if (key === "role" || key === "content" || key === "tool_calls") continue;
    if (typeof value === "string" && typeof target[key] === "string") target[key] = `${target[key]}${value}`;
    else if (Array.isArray(value) && Array.isArray(target[key])) target[key] = [...target[key], ...value];
    else target[key] = structuredClone(value);
  }
}
function streamInvocationError(error: Record<string, unknown>): ProviderInvocationError {
  const numericCode = typeof error.code === "number" ? error.code : undefined;
  const code = numericCode === undefined ? String(error.code ?? "error") : String(numericCode);
  const message = typeof error.message === "string" ? error.message : "OpenRouter stream failed";
  return new ProviderInvocationError(`openrouter.stream.${code}`, message, numericCode !== undefined && numericCode >= 500,
    numericCode === undefined ? undefined : { status: numericCode });
}

export function normalizeOpenRouterUsage(usage: Readonly<Record<string, unknown>>): NormalizedUsageV1 {
  const promptDetails = asObject(usage.prompt_tokens_details);
  const completionDetails = asObject(usage.completion_tokens_details);
  return compactUsage({ version: 1,
    inputTokens: numberValue(usage.prompt_tokens), outputTokens: numberValue(usage.completion_tokens),
    reasoningTokens: numberValue(completionDetails.reasoning_tokens),
    cacheReadTokens: numberValue(promptDetails.cached_tokens),
    cacheWriteTokens: numberValue(promptDetails.cache_write_tokens),
    totalTokens: numberValue(usage.total_tokens), costUsd: numberValue(usage.cost) });
}

function projectMessages(content: readonly NormalizedContent[]): unknown[] {
  const hasNative = content.some((item) => item.type === "provider-native" && item.provider === "openrouter.chat");
  const messages: unknown[] = [];
  for (const item of content) {
    if (item.type === "provider-native" && item.provider === "openrouter.chat") { messages.push(item.value); continue; }
    if (item.type === "text" && (item.role === "system" || item.role === "user")) {
      messages.push({ role: item.role, content: item.text }); continue;
    }
    if (item.type === "text" && item.role === "assistant" && !hasNative) {
      messages.push({ role: "assistant", content: item.text }); continue;
    }
    if (item.type === "tool-call" && !hasNative) messages.push({ role: "assistant", content: null, tool_calls: [{
      id: item.callId, type: "function", function: { name: item.toolName, arguments: JSON.stringify(item.input) } }] });
    if (item.type === "tool-result") messages.push({ role: "tool", tool_call_id: item.callId,
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
  }
  return messages;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value) as unknown; }
  catch (error) { throw new ProviderInvocationError("openrouter.invalid-tool-arguments",
    `Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`, false); }
}
function safeErrorMessage(value: string): string {
  try { const parsed = asObject(JSON.parse(value)); const error = asObject(parsed.error); return typeof error.message === "string" ? error.message : value.slice(0, 500); }
  catch { return value.slice(0, 500); }
}
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function asObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function compactUsage(value: Readonly<Record<string, number | undefined>> & { readonly version: 1 }): NormalizedUsageV1 {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as NormalizedUsageV1;
}
