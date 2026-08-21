import assert from "node:assert/strict";
import test from "node:test";
import { FakeWorker } from "@car/core";
import { createDefaultRuntime, DemoAgentDriver, FakeProvider } from "../dist/index.js";

test("default runtime exposes the complete development workspace tool set", () => {
  const runtime = createDefaultRuntime({ worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  assert.deepEqual(runtime.capabilities().tools.map((tool) => tool.name),
    ["read", "list", "search", "write", "apply_patch", "shell", "git_status"]);
  runtime.close();
});

test("demo driver completes a model-tool-model loop with durable attempts", async () => {
  const contexts = [];
  let invocation = 0;
  const provider = {
    id: "loop-provider",
    profile: { id: "loop", provider: "fake", model: "loop", endpoint: "fake://loop", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.tools.calls": { supported: true } } },
    async invoke(request) {
      contexts.push(request.context.content);
      request.recordRequest({ input: request.context.content });
      invocation++;
      const turn = invocation === 1
        ? { content: [{ type: "tool-call", callId: "call-1", toolName: "read", input: { path: "README.md" } }] }
        : { content: [{ type: "text", role: "assistant", text: "The file says hello." }], finishReason: "completed" };
      request.recordEvent("interaction.completed", turn); return turn;
    },
  };
  const worker = new FakeWorker(() => ({ ok: true, output: "hello" }));
  const runtime = createDefaultRuntime({ provider, worker });
  const session = await runtime.createSession("session");
  const run = await runtime.run(session.id, "Read the file");
  assert.equal(run.status, "completed");
  assert.equal(runtime.getModelAttempts(run.id).length, 2);
  assert.equal(contexts[1].some((content) => content.type === "tool-result" && content.output === "hello"), true);
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind),
    ["user", "tool-call", "tool-result", "assistant"]);
  runtime.close();
});

test("demo driver records every retry decision and eventual success", async () => {
  const provider = new FakeProvider([
    { type: "failure", code: "temporary", message: "try again", retryable: true },
    { type: "turn", turn: { content: [{ type: "text", role: "assistant", text: "recovered" }] } },
  ]);
  const driver = new DemoAgentDriver({ sleep: async () => {} });
  const runtime = createDefaultRuntime({ provider, driver, worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  const session = await runtime.createSession("session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  const attempts = runtime.getModelAttempts(run.id);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "completed"]);
  assert.deepEqual(attempts[0].retryDecision, { retry: true, reason: "temporary", retryNumber: 1, backoffMs: 250 });
  assert.equal(attempts[1].retryOfAttemptId, attempts[0].id);
  runtime.close();
});

test("demo driver stops repeated identical tool calls", async () => {
  const call = { type: "tool-call", callId: "call", toolName: "read", input: { path: "README.md" } };
  const provider = { id: "repeat", profile: { id: "repeat", provider: "fake", model: "repeat",
    endpoint: "fake://repeat", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.tools.calls": { supported: true } } },
    async invoke(request) { request.recordRequest({}); request.recordEvent("done", {}); return { content: [call] }; } };
  const runtime = createDefaultRuntime({ provider, worker: new FakeWorker(() => ({ ok: true, output: "same" })) });
  const session = await runtime.createSession("session");
  const run = await runtime.run(session.id, "loop");
  assert.equal(run.status, "failed");
  assert.match(run.error, /Repeated tool call limit/);
  assert.equal(runtime.getModelAttempts(run.id).length, 3);
  runtime.close();
});
