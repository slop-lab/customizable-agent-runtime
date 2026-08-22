import { join } from "node:path";
import type {
  AgentDriver, DriverContext, ExecutionWorker, JsonObject, ModelInvocationRequest, ModelProvider,
  ProviderCapabilitiesV1, ProviderProfile, ProviderTurn, RuntimeProvenanceOptions, RuntimeSystem, Tool,
  WorkerResponse, WorkspaceHandle,
} from "@car/core";
import {
  ArtifactStore, KernelDatabase, ModelAttemptFailure, ProviderInvocationError, Runtime, RuntimeError, ToolDispatcher,
} from "@car/core";
import { LocalDevelopmentWorker } from "./local-worker.js";
import { EnvironmentCredentialResolver } from "./credentials.js";
import { GoogleFetchInteractionsTransport, GoogleInteractionsProvider } from "./google-provider.js";
import { OpenRouterChatProvider, OpenRouterFetchTransport } from "./openrouter-provider.js";

export { LocalDevelopmentWorker } from "./local-worker.js";
export * from "./credentials.js";
export * from "./google-provider.js";
export * from "./openrouter-provider.js";
export * from "./sse.js";

export type FakeProviderAction =
  | { readonly type: "turn"; readonly turn: ProviderTurn }
  | { readonly type: "failure"; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly type: "delay"; readonly milliseconds: number };

export class FakeProvider implements ModelProvider {
  readonly id = "fake.echo";
  readonly version = "1";
  readonly transport = { id: "core.transport.in-process", version: "1" } as const;
  readonly profile: ProviderProfile = { id: "fake", provider: "fake", model: "echo",
    endpoint: "fake://local", credentialHandle: "none" };
  readonly capabilities: ProviderCapabilitiesV1 = { version: 1, values: {
    "core.streaming.text": { supported: true }, "core.tools.calls": { supported: true,
      constraints: { parallel: false } }, "core.cancellation": { supported: true },
  } };
  #index = 0;

  constructor(private readonly actions?: readonly FakeProviderAction[]) {}

  async invoke(request: ModelInvocationRequest): Promise<ProviderTurn> {
    request.signal.throwIfAborted();
    request.recordRequest({ model: this.profile.model, store: false, input: request.context.content,
      tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema })) });
    while (this.actions && this.#index < this.actions.length) {
      const action = this.actions[this.#index++]!;
      if (action.type === "delay") { await abortableDelay(action.milliseconds, request.signal); continue; }
      if (action.type === "failure") throw new ProviderInvocationError(action.code, action.message, action.retryable);
      request.recordEvent("interaction.completed", action.turn);
      return action.turn;
    }
    const latest = [...request.context.content].reverse().find((content) => content.type === "text" && content.role === "user");
    const turn: ProviderTurn = { content: [{ type: "text", role: "assistant",
      text: `Fake provider received: ${latest?.type === "text" ? latest.text : ""}` }], finishReason: "completed" };
    request.recordEvent("interaction.completed", turn); return turn;
  }
}

export interface DemoDriverOptions {
  readonly maximumAttempts?: number;
  readonly maximumRetries?: number;
  readonly repeatedToolCallLimit?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class DemoAgentDriver implements AgentDriver {
  readonly id = "defaults.driver.demo";
  readonly version = "1";
  readonly #maximumAttempts: number;
  readonly #maximumRetries: number;
  readonly #repeatedToolCallLimit: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly configuration: JsonObject;

  constructor(options: DemoDriverOptions = {}) {
    this.#maximumAttempts = options.maximumAttempts ?? 12;
    this.#maximumRetries = options.maximumRetries ?? 3;
    this.#repeatedToolCallLimit = options.repeatedToolCallLimit ?? 3;
    this.#sleep = options.sleep ?? abortableDelay;
    this.configuration = { maximumAttempts: this.#maximumAttempts, maximumRetries: this.#maximumRetries,
      repeatedToolCallLimit: this.#repeatedToolCallLimit,
      retryBackoff: { kind: "exponential", initialMs: 250, maximumMs: 2_000 } };
  }

  async run(context: DriverContext): Promise<void> {
    const calls = new Map<string, number>();
    let retries = 0;
    let retryOfAttemptId: string | undefined;
    for (let attemptNumber = 1; attemptNumber <= this.#maximumAttempts; attemptNumber++) {
      context.signal.throwIfAborted();
      let turn: Awaited<ReturnType<DriverContext["invokeModel"]>>;
      try { turn = await context.invokeModel(retryOfAttemptId === undefined ? {} : { retryOfAttemptId }); }
      catch (error) {
        context.signal.throwIfAborted();
        if (!(error instanceof ModelAttemptFailure) || !error.providerError.retryable || retries >= this.#maximumRetries) throw error;
        retries++;
        const backoffMs = Math.min(250 * (2 ** (retries - 1)), 2_000);
        await context.recordRetryDecision(error.attemptId, { retry: true, reason: error.providerError.code,
          retryNumber: retries, backoffMs });
        retryOfAttemptId = error.attemptId;
        await this.#sleep(backoffMs, context.signal);
        continue;
      }
      retries = 0;
      retryOfAttemptId = undefined;
      for (const content of turn.content) await context.append(content);
      const toolCalls = turn.content.filter((value) => value.type === "tool-call");
      if (toolCalls.length === 0) return;
      for (const call of toolCalls) {
        const fingerprint = `${call.toolName}:${stableJson(call.input)}`;
        const count = (calls.get(fingerprint) ?? 0) + 1;
        calls.set(fingerprint, count);
        if (count >= this.#repeatedToolCallLimit) throw new RuntimeError("conflict", `Repeated tool call limit reached: ${call.toolName}`);
        await context.dispatch(call);
      }
    }
    throw new RuntimeError("conflict", `Maximum model attempts reached: ${this.#maximumAttempts}`);
  }
}

export interface DefaultRuntimeOptions {
  readonly system?: RuntimeSystem;
  readonly databasePath?: string;
  readonly artifactRoot?: string;
  readonly workspaceRoot?: string;
  readonly workspace?: WorkspaceHandle;
  readonly worker?: ExecutionWorker;
  readonly provider?: ModelProvider;
  readonly driver?: AgentDriver;
  readonly provenance?: RuntimeProvenanceOptions;
}

export function createRuntimeProvenanceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeProvenanceOptions {
  return { runtime: { id: "@car/core", version: "0.0.0",
    ...(environment.CAR_SOURCE_REVISION === undefined ? {} : { sourceRevision: environment.CAR_SOURCE_REVISION }) } };
}

export function createProviderFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelProvider {
  const selected = environment.CAR_PROVIDER ?? (environment.OPENROUTER_API_KEY ? "openrouter" : "fake");
  if (selected === "fake") return new FakeProvider();
  if (selected === "openrouter") {
    const model = environment.CAR_OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it";
    const endpoint = environment.CAR_OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions";
    const credentialHandle = "env:OPENROUTER_API_KEY";
    const credentials = new EnvironmentCredentialResolver(environment);
    return new OpenRouterChatProvider({ model, endpoint, credentialHandle,
      transport: new OpenRouterFetchTransport(endpoint, credentialHandle, credentials) });
  }
  if (selected !== "google-ai-studio") throw new RuntimeError("validation", `Unknown provider: ${selected}`);
  const model = environment.CAR_GOOGLE_MODEL ?? "gemini-3.7-flash";
  const endpoint = environment.CAR_GOOGLE_ENDPOINT ?? "https://generativelanguage.googleapis.com/v1beta/interactions";
  const credentialHandle = "env:TEMPORARY_GEMINI_API_KEY";
  const credentials = new EnvironmentCredentialResolver(environment);
  const transport = new GoogleFetchInteractionsTransport(endpoint, credentialHandle, credentials);
  return new GoogleInteractionsProvider({ model, endpoint, credentialHandle, transport });
}

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): Runtime {
  const workspace = options.workspace ?? "default" as WorkspaceHandle;
  const worker = options.worker ?? new LocalDevelopmentWorker({ workspace, root: options.workspaceRoot ?? process.cwd() });
  const provenance: RuntimeProvenanceOptions = {
    ...(options.provenance ?? {}),
    ...(options.provenance?.worker !== undefined || worker.identity === undefined ? {} : { worker: worker.identity }),
  };
  return new Runtime(options.provider ?? new FakeProvider(), options.driver ?? new DemoAgentDriver(),
    new ToolDispatcher(createWorkerTools(worker)), {
      workspace,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.databasePath === undefined ? {} : { database: new KernelDatabase(options.databasePath) }),
      ...(options.artifactRoot === undefined ? {} : { artifactStore: new ArtifactStore(options.artifactRoot) }),
      provenance,
    });
}

export function createWorkerTools(worker: ExecutionWorker): readonly Tool[] {
  const read: Tool = {
    description: { name: "read", version: "1", description: "Read a UTF-8 file through the workspace worker.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      validateInput: (input) => isPathInput(input) ? undefined : "Expected an object with a string path." },
    async execute(input, context) {
      const value = input as { path: string };
      return toolResult(await worker.execute({ type: "readFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path }, context.signal));
    },
  };
  const shell: Tool = {
    description: { name: "shell", version: "1", description: "Run a non-interactive shell command through the workspace worker.",
      inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      validateInput: (input) => isCommandInput(input) ? undefined : "Expected an object with a string command." },
    async execute(input, context) {
      const value = input as { command: string; cwd?: string };
      return toolResult(await worker.execute({ type: "shell", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, command: value.command,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }, context.signal));
    },
  };
  const list: Tool = {
    description: { name: "list", version: "1", description: "List a directory through the workspace worker.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      validateInput: (input) => isOptionalPathInput(input) ? undefined : "Expected an object with an optional string path." },
    async execute(input, context) {
      const value = input as { path?: string };
      return toolResult(await worker.execute({ type: "list", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path ?? "." }, context.signal));
    },
  };
  const search: Tool = {
    description: { name: "search", version: "1", description: "Search workspace text with a regular expression through the workspace worker.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"] },
      validateInput: (input) => isSearchInput(input) ? undefined : "Expected an object with a non-empty query and optional string path." },
    async execute(input, context) {
      const value = input as { query: string; path?: string };
      return toolResult(await worker.execute({ type: "search", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, query: value.query,
        ...(value.path === undefined ? {} : { path: value.path }) }, context.signal));
    },
  };
  const write: Tool = {
    description: { name: "write", version: "1", description: "Replace a UTF-8 file through the workspace worker, creating parent directories when needed.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"] },
      validateInput: (input) => isWriteInput(input) ? undefined : "Expected an object with string path and content." },
    async execute(input, context) {
      const value = input as { path: string; content: string };
      return toolResult(await worker.execute({ type: "writeFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path, content: value.content }, context.signal));
    },
  };
  const applyPatch: Tool = {
    description: { name: "apply_patch", version: "1", description: "Apply a standard unified diff relative to the workspace root.",
      inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
      validateInput: (input) => isPatchInput(input) ? undefined : "Expected an object with a non-empty unified-diff patch." },
    async execute(input, context) {
      const value = input as { patch: string };
      return toolResult(await worker.execute({ type: "applyPatch", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, patch: value.patch }, context.signal));
    },
  };
  const gitStatus: Tool = {
    description: { name: "git_status", version: "1", description: "Show concise Git workspace status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validateInput: (input) => isEmptyObject(input) ? undefined : "Expected an empty object." },
    async execute(_input, context) {
      return toolResult(await worker.execute({ type: "gitStatus", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline }, context.signal));
    },
  };
  return [read, list, search, write, applyPatch, shell, gitStatus];
}

function toolResult(response: WorkerResponse) {
  if (response.ok) return { output: response.output };
  throw new RuntimeError(response.code === "cancelled" ? "cancelled" : "internal", response.message,
    { workerCode: response.code, uncertain: response.uncertain ?? false });
}
function isPathInput(input: unknown): input is { path: string } {
  return typeof input === "object" && input !== null && "path" in input && typeof (input as { path?: unknown }).path === "string";
}
function isCommandInput(input: unknown): input is { command: string; cwd?: string } {
  if (typeof input !== "object" || input === null || !("command" in input) || typeof (input as { command?: unknown }).command !== "string") return false;
  return !("cwd" in input) || (input as { cwd?: unknown }).cwd === undefined || typeof (input as { cwd?: unknown }).cwd === "string";
}
function isOptionalPathInput(input: unknown): input is { path?: string } {
  return typeof input === "object" && input !== null && (!("path" in input) ||
    (input as { path?: unknown }).path === undefined || typeof (input as { path?: unknown }).path === "string");
}
function isSearchInput(input: unknown): input is { query: string; path?: string } {
  if (typeof input !== "object" || input === null || !("query" in input) ||
    typeof (input as { query?: unknown }).query !== "string" || (input as { query: string }).query.length === 0) return false;
  return !("path" in input) || (input as { path?: unknown }).path === undefined ||
    typeof (input as { path?: unknown }).path === "string";
}
function isWriteInput(input: unknown): input is { path: string; content: string } {
  return typeof input === "object" && input !== null && "path" in input && "content" in input &&
    typeof (input as { path?: unknown }).path === "string" && typeof (input as { content?: unknown }).content === "string";
}
function isPatchInput(input: unknown): input is { patch: string } {
  return typeof input === "object" && input !== null && "patch" in input &&
    typeof (input as { patch?: unknown }).patch === "string" && (input as { patch: string }).patch.length > 0;
}
function isEmptyObject(input: unknown): input is Record<string, never> {
  return typeof input === "object" && input !== null && !Array.isArray(input) && Object.keys(input).length === 0;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Cancelled")); }, { once: true });
  });
}
