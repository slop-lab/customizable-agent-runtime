import { join } from "node:path";
import type {
  AgentDriver, DriverContext, ExecutionWorker, JsonObject, ModelInvocationRequest, ModelProvider,
  ProviderCapabilitiesV1, ProviderProfile, ProviderTurn, RuntimeSystem, Tool, WorkerResponse, WorkspaceHandle,
} from "@car/core";
import {
  ArtifactStore, KernelDatabase, ModelAttemptFailure, ProviderInvocationError, Runtime, RuntimeError, ToolDispatcher,
} from "@car/core";
import { LocalDevelopmentWorker } from "./local-worker.js";

export { LocalDevelopmentWorker } from "./local-worker.js";

export type FakeProviderAction =
  | { readonly type: "turn"; readonly turn: ProviderTurn }
  | { readonly type: "failure"; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly type: "delay"; readonly milliseconds: number };

export class FakeProvider implements ModelProvider {
  readonly id = "fake.echo";
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

  constructor(options: DemoDriverOptions = {}) {
    this.#maximumAttempts = options.maximumAttempts ?? 12;
    this.#maximumRetries = options.maximumRetries ?? 3;
    this.#repeatedToolCallLimit = options.repeatedToolCallLimit ?? 3;
    this.#sleep = options.sleep ?? abortableDelay;
  }

  async run(context: DriverContext): Promise<void> {
    const calls = new Map<string, number>();
    let retries = 0;
    for (let attemptNumber = 1; attemptNumber <= this.#maximumAttempts; attemptNumber++) {
      context.signal.throwIfAborted();
      let turn: Awaited<ReturnType<DriverContext["invokeModel"]>>;
      try { turn = await context.invokeModel(); }
      catch (error) {
        if (!(error instanceof ModelAttemptFailure) || !error.providerError.retryable || retries >= this.#maximumRetries) throw error;
        retries++;
        const backoffMs = Math.min(250 * (2 ** (retries - 1)), 2_000);
        await context.recordRetryDecision(error.attemptId, { retry: true, reason: error.providerError.code,
          retryNumber: retries, backoffMs });
        await this.#sleep(backoffMs, context.signal);
        continue;
      }
      retries = 0;
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
}

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): Runtime {
  const workspace = options.workspace ?? "default" as WorkspaceHandle;
  const worker = options.worker ?? new LocalDevelopmentWorker({ workspace, root: options.workspaceRoot ?? process.cwd() });
  return new Runtime(options.provider ?? new FakeProvider(), options.driver ?? new DemoAgentDriver(),
    new ToolDispatcher(createWorkerTools(worker)), {
      workspace,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.databasePath === undefined ? {} : { database: new KernelDatabase(options.databasePath) }),
      ...(options.artifactRoot === undefined ? {} : { artifactStore: new ArtifactStore(options.artifactRoot) }),
    });
}

export function createWorkerTools(worker: ExecutionWorker): readonly Tool[] {
  const read: Tool = {
    description: { name: "read", description: "Read a UTF-8 file through the workspace worker.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      validateInput: (input) => isPathInput(input) ? undefined : "Expected an object with a string path." },
    async execute(input, context) {
      const value = input as { path: string };
      return toolResult(await worker.execute({ type: "readFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path }, context.signal));
    },
  };
  const shell: Tool = {
    description: { name: "shell", description: "Run a non-interactive shell command through the workspace worker.",
      inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      validateInput: (input) => isCommandInput(input) ? undefined : "Expected an object with a string command." },
    async execute(input, context) {
      const value = input as { command: string; cwd?: string };
      return toolResult(await worker.execute({ type: "shell", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, command: value.command,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }, context.signal));
    },
  };
  return [read, shell];
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
