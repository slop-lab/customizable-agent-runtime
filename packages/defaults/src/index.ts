import { readFile } from "node:fs/promises";
import type { ModelRequest, Provider, Tool } from "@car/core";
import { Runtime, ToolDispatcher } from "@car/core";

export class FakeProvider implements Provider {
  readonly id = "fake.echo";
  readonly capabilities = {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    cancellation: true,
  } as const;

  async *stream(request: ModelRequest) {
    request.signal.throwIfAborted();
    const latest = [...request.records].reverse().find((record) => record.kind === "user");
    yield { content: { type: "text" as const, text: `Fake provider received: ${JSON.stringify(latest?.data)}` } };
  }
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

export function createDefaultRuntime(): Runtime {
  return new Runtime(new FakeProvider(), new ToolDispatcher([readTool]));
}
