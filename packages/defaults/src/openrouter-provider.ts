import type {
  JsonObject, ModelInvocationRequest, ModelProvider, NormalizedContent, NormalizedUsageV1, ProviderCapabilitiesV1,
  ProviderProfile, ProviderTurn,
} from "@car/core";
import { ProviderInvocationError } from "@car/core";
import type { CredentialResolver } from "./credentials.js";

export interface OpenRouterTransport {
  send(body: JsonObject, signal: AbortSignal): Promise<unknown>;
}

export class OpenRouterFetchTransport implements OpenRouterTransport {
  constructor(
    private readonly endpoint: string,
    private readonly credentialHandle: string,
    private readonly credentials: CredentialResolver,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async send(body: JsonObject, signal: AbortSignal): Promise<unknown> {
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
    try { return await response.json() as unknown; }
    catch (error) { throw new ProviderInvocationError("openrouter.invalid-json",
      `Invalid OpenRouter response JSON: ${error instanceof Error ? error.message : String(error)}`, false); }
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
    "core.streaming.text": { supported: false },
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
    const body = { model: this.options.model, messages: projectMessages(request.context.content),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name,
        description: tool.description, parameters: tool.inputSchema ?? { type: "object", additionalProperties: true } } })) };
    request.recordRequest(body);
    const payload = await this.options.transport.send(body, request.signal);
    request.recordEvent("chat.completion", payload);
    const response = asObject(payload);
    const choice = asObject(Array.isArray(response.choices) ? response.choices[0] : undefined);
    const message = asObject(choice.message);
    const content: NormalizedContent[] = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      content.push({ type: "text", role: "assistant", text: message.content });
    }
    if (Array.isArray(message.tool_calls)) for (const value of message.tool_calls) {
      const call = asObject(value); const fn = asObject(call.function);
      if (typeof call.id === "string" && typeof fn.name === "string") content.push({ type: "tool-call",
        callId: call.id, toolName: fn.name, input: parseArguments(fn.arguments) });
    }
    content.push({ type: "provider-native", provider: "openrouter.chat", value: message });
    const usage = asObjectOrUndefined(response.usage);
    return { content, ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage, normalizedUsage: normalizeOpenRouterUsage(usage) } : {}),
      ...(typeof response.id === "string" ? { providerResponseId: response.id } : {}) };
  }
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
