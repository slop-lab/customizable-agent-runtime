import assert from "node:assert/strict";
import test from "node:test";
import { FakeWorker, PluginHost, ProviderInvocationError } from "@car/core";
import { createDefaultRuntime, createRuntimeProvenanceFromEnvironment, DemoAgentDriver, FakeProvider } from "../dist/index.js";

test("runtime source revision is host-injected through a provenance option", () => {
  assert.deepEqual(createRuntimeProvenanceFromEnvironment({ CAR_SOURCE_REVISION: "abc123" }), {
    runtime: { id: "@car/core", version: "0.0.0", sourceRevision: "abc123" },
  });
  assert.deepEqual(createRuntimeProvenanceFromEnvironment({}), {
    runtime: { id: "@car/core", version: "0.0.0" },
  });
});

test("default runtime exposes the complete development workspace tool set", () => {
  const runtime = createDefaultRuntime({ worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  assert.deepEqual(runtime.capabilities().tools.map((tool) => tool.name),
    ["read", "list", "search", "write", "apply_patch", "shell", "git_status"]);
  runtime.close();
});

test("default runtime exposes plugin tools, identity, provenance, and cleanup", async () => {
  let stopped = 0;
  const host = await PluginHost.initialize([{
    manifest: { apiVersion: 1, id: "integration.example", version: "1",
      configuration: { endpoint: "https://example.test", token: "must-not-survive" } },
    setup(registrar) {
      registrar.registerTool({
        description: { name: "integration.example.lookup", version: "1", description: "lookup" },
        async execute() { return { output: "plugin result" }; },
      });
    },
    stop() { stopped++; },
  }]);
  let invocation = 0;
  const provider = { id: "plugin-provider", profile: { id: "plugin", provider: "fake", model: "plugin",
    endpoint: "fake://plugin", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.tools.calls": { supported: true } } },
    async invoke(request) {
      request.recordRequest({ tools: request.tools }); invocation++;
      const turn = invocation === 1
        ? { content: [{ type: "tool-call", callId: "call", toolName: "integration.example.lookup", input: {} }] }
        : { content: [{ type: "text", role: "assistant", text: "done" }], finishReason: "completed" };
      request.recordEvent("done", turn); return turn;
    } };
  const runtime = createDefaultRuntime({ provider, pluginHost: host,
    worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  assert.deepEqual(runtime.capabilities().plugins,
    [{ id: "integration.example", version: "1", dependencies: [] }]);
  assert.equal(runtime.capabilities().tools.some((tool) => tool.name === "integration.example.lookup"), true);
  const session = await runtime.createSession("plugin-session");
  const run = await runtime.run(session.id, "use the plugin");
  assert.equal(run.status, "completed");
  assert.equal(runtime.getRecords(session.id).some((record) =>
    record.kind === "tool-result" && record.data.output === "plugin result"), true);
  const provenance = runtime.getRunProvenance(run.id);
  assert.deepEqual(provenance.manifest.plugins, [{ id: "integration.example", version: "1", dependencies: [],
    configuration: { endpoint: "https://example.test", token: "[redacted]" } }]);
  runtime.close();
  assert.equal(stopped, 1);
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

test("demo driver does not schedule a retry after cancellation wins a provider race", async () => {
  let providerStarted; let releaseProvider; let sleepCount = 0;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const released = new Promise((resolve) => { releaseProvider = resolve; });
  const provider = { id: "cancel-race", profile: { id: "cancel-race", provider: "fake", model: "cancel-race",
    endpoint: "fake://cancel-race", credentialHandle: "none" },
    capabilities: { version: 1, values: {} }, async invoke(request) {
      request.recordRequest({}); providerStarted(); await released;
      throw new ProviderInvocationError("transport.network", "late network failure", true);
    } };
  const driver = new DemoAgentDriver({ sleep: async () => { sleepCount++; } });
  const runtime = createDefaultRuntime({ provider, driver,
    worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  const session = await runtime.createSession("session");
  const execution = await runtime.startRun(session.id, "cancel provider");
  await started; execution.cancel(); releaseProvider();
  const run = await execution.completion;
  assert.equal(run.status, "cancelled"); assert.equal(sleepCount, 0);
  assert.equal(runtime.getModelAttempts(run.id).length, 1);
  assert.equal(runtime.getModelAttempts(run.id)[0].retryDecision, undefined);
  assert.equal(runtime.getModelAttempts(run.id)[0].error.code, "provider.cancelled");
  runtime.close();
});

test("demo driver cancellation during retry backoff starts no additional attempt", async () => {
  let backoffStarted;
  const started = new Promise((resolve) => { backoffStarted = resolve; });
  const provider = new FakeProvider([
    { type: "failure", code: "temporary", message: "try later", retryable: true },
  ]);
  const driver = new DemoAgentDriver({ sleep: async (_milliseconds, signal) => {
    backoffStarted();
    await new Promise((_resolve, reject) => signal.addEventListener("abort",
      () => reject(signal.reason), { once: true }));
  } });
  const runtime = createDefaultRuntime({ provider, driver,
    worker: new FakeWorker(() => ({ ok: true, output: "unused" })) });
  const session = await runtime.createSession("session");
  const execution = await runtime.startRun(session.id, "cancel backoff");
  await started; execution.cancel();
  const run = await execution.completion;
  assert.equal(run.status, "cancelled");
  const attempts = runtime.getModelAttempts(run.id);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].retryDecision,
    { retry: true, reason: "temporary", retryNumber: 1, backoffMs: 250 });
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
