import { readFile } from "node:fs/promises";
import type { ModelChunk, ModelRequest, Provider, RuntimeSystem, Tool } from "@car/core";
import { KernelDatabase, Runtime, ToolDispatcher } from "@car/core";

export class FakeProvider implements Provider {
  readonly id = "fake.echo";
  readonly capabilities = {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    cancellation: true,
  } as const;

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
    yield { content: { type: "text" as const, text: `Fake provider received: ${JSON.stringify(latest?.data)}` } };
  }
}

export type FakeProviderStep =
  | { readonly type: "chunk"; readonly chunk: ModelChunk }
  | { readonly type: "delay"; readonly milliseconds: number }
  | { readonly type: "failure"; readonly message: string };

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cancelled"));
    }, { once: true });
  });
}

const readTool: Tool = {
  description: { name: "read", description: "Read a UTF-8 file from the runtime workspace." },
  async execute(input) {
    if (!isPathInput(input)) return { output: "Expected an object with a string path.", isError: true };
    return { output: await readFile(input.path, "utf8") };
  },
};

function isPathInput(input: unknown): input is { path: string } {
  return typeof input === "object" && input !== null && "path" in input &&
    typeof (input as { path?: unknown }).path === "string";
}

export interface DefaultRuntimeOptions {
  readonly system?: RuntimeSystem;
  readonly databasePath?: string;
}

export function createDefaultRuntime(options: DefaultRuntimeOptions | RuntimeSystem = {}): Runtime {
  const normalized = "clock" in options ? { system: options } : options;
  return new Runtime(new FakeProvider(), new ToolDispatcher([readTool]), {
    ...(normalized.system === undefined ? {} : { system: normalized.system }),
    ...(normalized.databasePath === undefined ? {} : { database: new KernelDatabase(normalized.databasePath) }),
  });
}
