import assert from "node:assert/strict";
import test from "node:test";
import { ProviderInvocationError } from "../dist/index.js";
import { appendOneTurnDriver, createTestRuntime, providerFrom } from "./agent-fixtures.js";

function deterministicSystem() {
  let id = 0; let tick = 0;
  return { ids: { next: () => `id-${++id}` },
    clock: { now: () => `2026-08-21T00:00:${String(tick++).padStart(2, "0")}.000Z` } };
}

test("runtime IDs and timestamps are injectable and model attempts are recorded", async () => {
  const provider = providerFrom(async () => ({ content: [{ type: "text", role: "assistant", text: "done" }],
    finishReason: "completed", usage: { totalTokens: 2 } }));
  const runtime = createTestRuntime(provider, [], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(session.id, "id-1");
  assert.equal(run.id, "id-3");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "assistant"]);
  const [attempt] = runtime.getModelAttempts(run.id);
  assert.equal(attempt.status, "completed");
  assert.deepEqual(attempt.usage, { totalTokens: 2 });
  assert.ok(runtime.getContextProjection(attempt.contextProjectionId));
  assert.equal(runtime.getArtifact(attempt.eventArtifactId).status, "completed");
  runtime.close();
});

test("provider failure and its attempt remain inspectable", async () => {
  const provider = providerFrom(async () => { throw new ProviderInvocationError("provider.failed", "provider failed", false); });
  const runtime = createTestRuntime(provider, [], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "failed");
  assert.equal(runtime.getRecords(session.id).at(-1).kind, "error");
  const [attempt] = runtime.getModelAttempts(run.id);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error.code, "provider.failed");
  runtime.close();
});

test("tool dispatch creates a terminal operation and result record", async () => {
  const provider = providerFrom(async () => ({ content: [
    { type: "tool-call", callId: "call", toolName: "effect", input: "value" },
  ] }));
  const tool = { description: { name: "effect", description: "effect" },
    async execute(input) { return { output: String(input) }; } };
  const runtime = createTestRuntime(provider, [tool], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "completed" }, { kind: "model", status: "completed" },
    { kind: "tool", status: "completed" },
  ]);
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "tool-call", "tool-result"]);
  runtime.close();
});

test("cancellation leaves no post-cancel assistant continuation", async () => {
  const provider = providerFrom(async (request) => {
    await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    return { content: [{ type: "text", role: "assistant", text: "must not appear" }] };
  });
  const runtime = createTestRuntime(provider, [], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const execution = await runtime.startRun(session.id, "cancel me");
  assert.equal(execution.run.status, "running");
  assert.equal(execution.cancel(), true);
  const run = await execution.completion;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user"]);
  assert.deepEqual(runtime.getModelAttempts(run.id).map((attempt) => attempt.status), ["cancelled"]);
  runtime.close();
});

test("cancellation during a tool leaves no post-cancel tool result continuation", async () => {
  const provider = providerFrom(async () => ({ content: [
    { type: "tool-call", callId: "call", toolName: "effect", input: {} },
  ] }));
  let toolStarted;
  const started = new Promise((resolve) => { toolStarted = resolve; });
  const tool = { description: { name: "effect", description: "effect" }, async execute(_input, context) {
    toolStarted();
    await new Promise((_resolve, reject) => context.signal.addEventListener("abort",
      () => reject(context.signal.reason), { once: true }));
    return { output: "must not appear" };
  } };
  const runtime = createTestRuntime(provider, [tool], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const execution = await runtime.startRun(session.id, "cancel tool");
  await started;
  execution.cancel();
  const run = await execution.completion;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "tool-call"]);
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "cancelled" }, { kind: "model", status: "completed" },
    { kind: "tool", status: "cancelled" },
  ]);
  runtime.close();
});

test("a driver can make tool failure terminal without changing runtime policy", async () => {
  const provider = providerFrom(async () => ({ content: [
    { type: "tool-call", callId: "call", toolName: "effect", input: {} },
  ] }));
  const tool = { description: { name: "effect", description: "effect" }, async execute() { throw new Error("side effect failed"); } };
  const strictDriver = { ...appendOneTurnDriver, async run(context) {
    const turn = await context.invokeModel();
    const call = turn.content[0];
    await context.append(call);
    const result = await context.dispatch(call);
    if (result.isError) throw new Error(result.output);
  } };
  const runtime = createTestRuntime(provider, [tool], { system: deterministicSystem() }, strictDriver);
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "failed");
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "failed" }, { kind: "model", status: "completed" }, { kind: "tool", status: "failed" },
  ]);
  runtime.close();
});
