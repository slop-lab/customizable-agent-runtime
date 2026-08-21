import type {
  ExecutionWorker,
  ModelChunk,
  ModelRequest,
  Provider,
  RuntimeSystem,
  Tool,
  WorkerResponse,
  WorkspaceHandle,
} from "@car/core";
import { KernelDatabase, Runtime, RuntimeError, ToolDispatcher } from "@car/core";
import { LocalDevelopmentWorker } from "./local-worker.js";

export { LocalDevelopmentWorker } from "./local-worker.js";

export class FakeProvider implements Provider {
  readonly id = "fake.echo";
  readonly capabilities = { streaming: true, toolCalls: true, parallelToolCalls: false, cancellation: true } as const;
  constructor(private readonly script?: readonly FakeProviderStep[]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    request.signal.throwIfAborted();
    if (this.script) {
      for (const step of this.script) {
        request.signal.throwIfAborted();
        if (step.type === "chunk") yield step.chunk;
        else if (step.type === "delay") await abortableDelay(step.milliseconds, request.signal);
        else throw new Error(step.message);
      }
      return;
    }
    const latest = [...request.records].reverse().find((record) => record.kind === "user");
    yield { content: { type: "text", text: `Fake provider received: ${JSON.stringify(latest?.data)}` } };
  }
}

export type FakeProviderStep =
  | { readonly type: "chunk"; readonly chunk: ModelChunk }
  | { readonly type: "delay"; readonly milliseconds: number }
  | { readonly type: "failure"; readonly message: string };

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Cancelled")); }, { once: true });
  });
}

export interface DefaultRuntimeOptions {
  readonly system?: RuntimeSystem;
  readonly databasePath?: string;
  readonly workspaceRoot?: string;
  readonly workspace?: WorkspaceHandle;
  readonly worker?: ExecutionWorker;
}

export function createDefaultRuntime(options: DefaultRuntimeOptions | RuntimeSystem = {}): Runtime {
  const normalized = "clock" in options ? { system: options } : options;
  const workspace = normalized.workspace ?? "default" as WorkspaceHandle;
  const worker = normalized.worker ?? new LocalDevelopmentWorker({ workspace, root: normalized.workspaceRoot ?? process.cwd() });
  return new Runtime(new FakeProvider(), new ToolDispatcher(createWorkerTools(worker)), {
    workspace,
    ...(normalized.system === undefined ? {} : { system: normalized.system }),
    ...(normalized.databasePath === undefined ? {} : { database: new KernelDatabase(normalized.databasePath) }),
  });
}

export function createWorkerTools(worker: ExecutionWorker): readonly Tool[] {
  const read: Tool = {
    description: { name: "read", description: "Read a UTF-8 file through the workspace worker.",
      validateInput: (input) => isPathInput(input) ? undefined : "Expected an object with a string path." },
    async execute(input, context) {
      const value = input as { path: string };
      return toolResult(await worker.execute({ type: "readFile", operationId: context.operationId,
        workspace: context.workspace, deadline: context.deadline, path: value.path }, context.signal));
    },
  };
  const shell: Tool = {
    description: { name: "shell", description: "Run a non-interactive shell command through the workspace worker.",
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
