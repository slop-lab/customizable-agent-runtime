import { dirname, join } from "node:path";
import type {
  AgentDriver, ContextTransform, DriverContext, ExecutionWorker, JsonObject, ModelInvocationRequest, ModelProvider,
  PluginHost, ProviderCapabilitiesV1, ProviderProfile, ProviderTurn, RuntimeProvenanceOptions, RuntimeSystem, Tool,
  WorkerResponse, WorkspaceHandle,
} from "@car/core";
import {
  ArtifactIngressStore, ArtifactStore, KernelDatabase, ModelAttemptFailure, OldToolResultPruningTransform,
  ProviderInvocationError, Runtime, RuntimeError, ToolDispatcher,
} from "@car/core";
import { LocalDevelopmentWorker } from "./local-worker.js";
import { ProcessIsolatedWorker } from "./isolated-worker.js";
import { EnvironmentCredentialResolver } from "./credentials.js";
import { GoogleFetchInteractionsTransport, GoogleInteractionsProvider } from "./google-provider.js";
import { OpenRouterChatProvider, OpenRouterFetchTransport } from "./openrouter-provider.js";

export { LocalDevelopmentWorker } from "./local-worker.js";
export { ProcessIsolatedWorker, type ProcessIsolatedWorkerOptions } from "./isolated-worker.js";
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
  readonly artifactIngressRoot?: string;
  readonly workspaceRoot?: string;
  readonly workspace?: WorkspaceHandle;
  readonly worker?: ExecutionWorker;
  readonly workerBackend?: "local" | "isolated-process";
  readonly workerLeaseTtlMs?: number;
  readonly maximumInlineOutputBytes?: number;
  readonly maximumArtifactBytes?: number;
  readonly provider?: ModelProvider;
  readonly driver?: AgentDriver;
  readonly pluginHost?: PluginHost;
  readonly provenance?: RuntimeProvenanceOptions;
  readonly contextTransforms?: readonly ContextTransform[];
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

export function createContextTransformsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ContextTransform[] {
  const enabled = environment.CAR_CONTEXT_TOOL_RESULT_PRUNING ?? "on";
  if (enabled === "off") return [];
  if (enabled !== "on") throw new RuntimeError("validation", "CAR_CONTEXT_TOOL_RESULT_PRUNING must be on or off");
  const protectedValue = environment.CAR_CONTEXT_PROTECTED_TOOLS;
  return [new OldToolResultPruningTransform({
    ...environmentInteger(environment, "CAR_CONTEXT_PRUNE_TRIGGER", "minimumCompletedToolExchanges"),
    ...environmentInteger(environment, "CAR_CONTEXT_RETAIN_TOOL_RESULTS", "retainRecentToolExchanges"),
    ...environmentInteger(environment, "CAR_CONTEXT_PRUNE_BATCH", "pruneBatchSize"),
    ...(protectedValue === undefined ? {} : {
      protectedToolNames: protectedValue.split(",").map((value) => value.trim()).filter(Boolean),
    }),
  })];
}

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): Runtime {
  const workspace = options.workspace ?? "default" as WorkspaceHandle;
  const artifactIngressRoot = options.artifactIngressRoot ?? (options.artifactRoot === undefined
    ? undefined : join(dirname(options.artifactRoot), "worker-ingress"));
  const artifactIngress = artifactIngressRoot === undefined ? undefined : new ArtifactIngressStore(artifactIngressRoot,
    options.maximumArtifactBytes ?? 16 * 1024 * 1024);
  const worker: ExecutionWorker = options.worker ?? (options.workerBackend === "isolated-process"
    ? new ProcessIsolatedWorker({ workspace, root: options.workspaceRoot ?? process.cwd(),
      ...(artifactIngress === undefined ? {} : { artifactIngress }),
      ...(options.workerLeaseTtlMs === undefined ? {} : { leaseTtlMs: options.workerLeaseTtlMs }),
      ...(options.maximumInlineOutputBytes === undefined ? {} : {
        maximumInlineOutputBytes: options.maximumInlineOutputBytes,
      }),
      ...(options.maximumArtifactBytes === undefined ? {} : { maximumArtifactBytes: options.maximumArtifactBytes }) })
    : new LocalDevelopmentWorker({ workspace, root: options.workspaceRoot ?? process.cwd(),
      ...(artifactIngress === undefined ? {} : { artifactIngress }),
      ...(options.maximumInlineOutputBytes === undefined ? {} : { maxOutputBytes: options.maximumInlineOutputBytes }),
      ...(options.maximumArtifactBytes === undefined ? {} : { maxArtifactBytes: options.maximumArtifactBytes }) }));
  const provenance: RuntimeProvenanceOptions = {
    ...(options.provenance ?? {}),
    ...(options.provenance?.worker !== undefined || worker.identity === undefined ? {} : { worker: worker.identity }),
    ...(options.provenance?.plugins !== undefined || options.pluginHost === undefined
      ? {} : { plugins: options.pluginHost.identities() }),
  };
  const closeResources = [
    ...(worker.close === undefined ? [] : [worker.close.bind(worker)]),
    ...(options.pluginHost === undefined ? [] : [async () => {
      const errors = await options.pluginHost!.close();
      if (errors.length > 0) throw new AggregateError(errors, "Plugin cleanup failed");
    }]),
  ];
  return new Runtime(options.provider ?? new FakeProvider(), options.driver ?? new DemoAgentDriver(),
    new ToolDispatcher([...createWorkerTools(worker), ...(options.pluginHost?.tools() ?? [])],
      options.pluginHost?.middleware() ?? []), {
      workspace,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.databasePath === undefined ? {} : { database: new KernelDatabase(options.databasePath) }),
      ...(options.artifactRoot === undefined ? {} : { artifactStore: new ArtifactStore(options.artifactRoot) }),
      ...(artifactIngress === undefined ? {} : { artifactIngress }),
      ...(closeResources.length === 0 ? {} : { closeResources }),
      contextTransforms: options.contextTransforms ?? [new OldToolResultPruningTransform()],
      provenance,
    });
}

export function createWorkerTools(worker: ExecutionWorker): readonly Tool[] {
  const read: Tool = {
    description: { name: "read", version: "1", description: "Read a UTF-8 file through the workspace worker.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2_000 } }, required: ["path"] },
      validateInput: (input) => isReadInput(input) ? undefined :
        "Expected a string path and optional positive offset/limit." },
    async execute(input, context) {
      const value = input as { path: string; offset?: number; limit?: number };
      return toolResult(await worker.execute({ type: "readFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path,
        ...(value.offset === undefined ? {} : { offset: value.offset }),
        ...(value.limit === undefined ? {} : { limit: value.limit }) }, context.signal));
    },
  };
  const bash: Tool = {
    description: { name: "bash", version: "1", description: "Run a non-interactive shell command through the workspace worker.",
      inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      validateInput: (input) => isCommandInput(input) ? undefined : "Expected an object with a string command." },
    async execute(input, context) {
      const value = input as { command: string; cwd?: string };
      return toolResult(await worker.execute({ type: "shell", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, command: value.command,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }, context.signal));
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
  const glob: Tool = {
    description: { name: "glob", version: "1", description: "Find workspace files matching a glob pattern.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 1_000 } }, required: ["pattern"] },
      validateInput: (input) => isGlobInput(input) ? undefined :
        "Expected a non-empty glob pattern and optional path/maxResults." },
    async execute(input, context) {
      const value = input as { pattern: string; path?: string; maxResults?: number };
      return toolResult(await worker.execute({ type: "glob", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, pattern: value.pattern,
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.maxResults === undefined ? {} : { maxResults: value.maxResults }) }, context.signal));
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
  const grep: Tool = {
    description: { name: "grep", version: "1", description: "Search workspace text with ripgrep-compatible regular expressions.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" },
        include: { type: "string" }, before: { type: "integer", minimum: 0, maximum: 50 },
        after: { type: "integer", minimum: 0, maximum: 50 },
        maxResults: { type: "integer", minimum: 1, maximum: 1_000 } }, required: ["query"] },
      validateInput: (input) => isGrepInput(input) ? undefined :
        "Expected a non-empty query and valid optional path/include/context/result limits." },
    async execute(input, context) {
      const value = input as { query: string; path?: string; include?: string; before?: number; after?: number;
        maxResults?: number };
      return toolResult(await worker.execute({ type: "search", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, query: value.query,
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.include === undefined ? {} : { include: value.include }),
        ...(value.before === undefined ? {} : { before: value.before }),
        ...(value.after === undefined ? {} : { after: value.after }),
        ...(value.maxResults === undefined ? {} : { maxResults: value.maxResults }) }, context.signal));
    },
  };
  const edit: Tool = {
    description: { name: "edit", version: "1", description: "Replace one exact UTF-8 text occurrence, or all matches when explicitly requested.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string", minLength: 1 },
        newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"] },
      validateInput: (input) => isEditInput(input) ? undefined :
        "Expected path, non-empty oldText, newText, and optional boolean replaceAll." },
    async execute(input, context) {
      const value = input as { path: string; oldText: string; newText: string; replaceAll?: boolean };
      return toolResult(await worker.execute({ type: "editFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path, oldText: value.oldText,
        newText: value.newText, ...(value.replaceAll === undefined ? {} : { replaceAll: value.replaceAll }) }, context.signal));
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
  const gitDiff: Tool = {
    description: { name: "git_diff", version: "1", description: "Show the working-tree or staged Git diff.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" },
        staged: { type: "boolean" } } },
      validateInput: (input) => isGitDiffInput(input) ? undefined :
        "Expected optional string path/cwd and optional boolean staged." },
    async execute(input, context) {
      const value = input as { path?: string; cwd?: string; staged?: boolean };
      return toolResult(await worker.execute({ type: "gitDiff", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline,
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        ...(value.staged === undefined ? {} : { staged: value.staged }) }, context.signal));
    },
  };
  return [read, glob, grep, edit, write, applyPatch, bash, gitStatus, gitDiff,
    list, search, shell];
}

function toolResult(response: WorkerResponse) {
  if (response.ok) return { output: response.output,
    ...(response.artifact === undefined ? {} : { artifactIngress: response.artifact }),
    ...(response.lease === undefined ? {} : { workerLease: response.lease }),
    ...(response.executionManifest === undefined ? {} : { workerExecutionManifest: response.executionManifest }) };
  throw new RuntimeError(response.code === "cancelled" ? "cancelled" : "internal", response.message,
    { workerCode: response.code, uncertain: response.uncertain ?? false,
      ...(response.lease === undefined ? {} : { workerLease: response.lease }),
      ...(response.executionManifest === undefined ? {} : { workerExecutionManifest: response.executionManifest }) });
}
function isReadInput(input: unknown): input is { path: string; offset?: number; limit?: number } {
  return isPathInput(input) && optionalInteger(input, "offset", 1, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(input, "limit", 1, 2_000);
}
function isPathInput(input: unknown): input is { path: string } {
  return isObject(input) && typeof input.path === "string";
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
function isGlobInput(input: unknown): input is { pattern: string; path?: string; maxResults?: number } {
  return isObject(input) && typeof input.pattern === "string" && input.pattern.length > 0 &&
    optionalString(input, "path") && optionalInteger(input, "maxResults", 1, 1_000);
}
function isGrepInput(input: unknown): input is { query: string; path?: string; include?: string; before?: number;
  after?: number; maxResults?: number } {
  return isObject(input) && typeof input.query === "string" && input.query.length > 0 && optionalString(input, "path") &&
    optionalString(input, "include") && optionalInteger(input, "before", 0, 50) &&
    optionalInteger(input, "after", 0, 50) && optionalInteger(input, "maxResults", 1, 1_000);
}
function isEditInput(input: unknown): input is { path: string; oldText: string; newText: string; replaceAll?: boolean } {
  return isObject(input) && typeof input.path === "string" && typeof input.oldText === "string" &&
    input.oldText.length > 0 && typeof input.newText === "string" &&
    (input.replaceAll === undefined || typeof input.replaceAll === "boolean");
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
function isGitDiffInput(input: unknown): input is { path?: string; cwd?: string; staged?: boolean } {
  return isObject(input) && optionalString(input, "path") && optionalString(input, "cwd") &&
    (input.staged === undefined || typeof input.staged === "boolean");
}
function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function optionalString(input: Readonly<Record<string, unknown>>, key: string): boolean {
  return input[key] === undefined || typeof input[key] === "string";
}
function optionalInteger(input: Readonly<Record<string, unknown>>, key: string, minimum: number, maximum: number): boolean {
  const value = input[key];
  return value === undefined || Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function environmentInteger(environment: Readonly<Record<string, string | undefined>>, name: string, key: string) {
  const value = environment[name];
  if (value === undefined) return {};
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new RuntimeError("validation", `${name} must be a positive integer`);
  }
  return { [key]: Number(value) };
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
