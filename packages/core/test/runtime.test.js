import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWorkerExecutionManifest, KernelDatabase, ProviderInvocationError } from "../dist/index.js";
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
  await runtime.close();
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
  await runtime.close();
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
  await runtime.close();
});

test("tool dispatch validates and persists one worker execution manifest per run lease", async () => {
  const provider = providerFrom(async () => ({ content: [
    { type: "tool-call", callId: "call", toolName: "effect", input: {} },
  ] }));
  const startedAt = "2026-08-21T00:00:00.000Z";
  const lease = { id: "lease-1", acquiredAt: startedAt, expiresAt: "2026-08-21T00:01:00.000Z" };
  const workerExecutionManifest = createWorkerExecutionManifest({ version: 1,
    worker: { id: "test.worker.process", version: "1" }, leaseId: lease.id, startedAt,
    runtime: { name: "node", version: "v24.0.0", platform: "linux", architecture: "x64" },
    workspace: { handle: "default" }, environment: { keys: ["PATH"] },
    isolation: { kind: "process", filesystem: "workspace-scoped", environment: "explicit-projection" },
    resourceLimits: { maximumInlineOutputBytes: 1_024, maximumArtifactBytes: 4_096 },
    requestTypes: ["readFile"],
  });
  const tool = { description: { name: "effect", description: "effect" }, async execute() {
    return { output: "done", workerLease: lease, workerExecutionManifest };
  } };
  const runtime = createTestRuntime(provider, [tool], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getRunWorkerExecutionManifests(run.id), [workerExecutionManifest]);
  const operation = runtime.getOperations(run.id).find((value) => value.kind === "tool");
  assert.deepEqual(operation.result, { output: "done" });
  await runtime.close();
});

test("cancellation leaves no post-cancel assistant continuation", async () => {
  let providerStarted; let finishProvider;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const providerCanFinish = new Promise((resolve) => { finishProvider = resolve; });
  const provider = providerFrom(async () => {
    providerStarted();
    await providerCanFinish;
    return { content: [{ type: "text", role: "assistant", text: "must not appear" }] };
  });
  const runtime = createTestRuntime(provider, [], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const execution = await runtime.startRun(session.id, "cancel me");
  assert.equal(execution.run.status, "running");
  await started;
  assert.equal(execution.cancel(), true);
  finishProvider();
  const run = await execution.completion;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user"]);
  assert.deepEqual(runtime.getModelAttempts(run.id).map((attempt) => attempt.status), ["cancelled"]);
  assert.equal(runtime.getModelAttempts(run.id)[0].error.code, "provider.cancelled");
  await runtime.close();
});

test("cancellation during a tool leaves no post-cancel tool result continuation", async () => {
  const provider = providerFrom(async () => ({ content: [
    { type: "tool-call", callId: "call", toolName: "effect", input: {} },
  ] }));
  let toolStarted; let finishTool;
  const started = new Promise((resolve) => { toolStarted = resolve; });
  const toolCanFinish = new Promise((resolve) => { finishTool = resolve; });
  const tool = { description: { name: "effect", description: "effect" }, async execute() {
    toolStarted();
    await toolCanFinish;
    return { output: "must not appear" };
  } };
  const runtime = createTestRuntime(provider, [tool], { system: deterministicSystem() });
  const session = await runtime.createSession("create-session");
  const execution = await runtime.startRun(session.id, "cancel tool");
  await started;
  execution.cancel();
  finishTool();
  const run = await execution.completion;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "tool-call"]);
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "cancelled" }, { kind: "model", status: "completed" },
    { kind: "tool", status: "cancelled" },
  ]);
  await runtime.close();
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
  await runtime.close();
});

test("runtime close awaits every resource and reports aggregate cleanup failure", async () => {
  const log = [];
  const runtime = createTestRuntime(providerFrom(async () => ({ content: [] })), [], {
    closeResources: [
      async () => { await Promise.resolve(); log.push("first"); throw new Error("first failed"); },
      () => { log.push("second"); },
    ],
  });
  await assert.rejects(() => runtime.close(), (error) => error instanceof AggregateError &&
    error.errors.length === 1 && error.errors[0].message === "first failed");
  assert.deepEqual(log, ["first", "second"]);
  await assert.rejects(() => runtime.close(), AggregateError);
  assert.deepEqual(log, ["first", "second"]);
});

test("runtime close cancels and drains active runs before closing persistence", async () => {
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const provider = providerFrom(async (request) => {
    providerStarted();
    await new Promise((_resolve, reject) => request.signal.addEventListener("abort",
      () => reject(request.signal.reason), { once: true }));
  });
  const runtime = createTestRuntime(provider);
  const session = await runtime.createSession("session");
  const execution = await runtime.startRun(session.id, "close during provider");
  await started;
  const closing = runtime.close();
  const run = await execution.completion;
  await closing;
  assert.equal(run.status, "cancelled");
  await assert.rejects(() => runtime.createSession("after-close"), /Runtime is closed/);
});

test("runtime close drains pending run admission before cancelling execution", async () => {
  const database = new KernelDatabase(":memory:");
  let releaseWriter;
  let writerStarted;
  const writerReady = new Promise((resolve) => { writerStarted = resolve; });
  const provider = providerFrom(async (request) => new Promise((_resolve, reject) => {
    if (request.signal.aborted) { reject(request.signal.reason); return; }
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }));
  const runtime = createTestRuntime(provider, [], { database });
  const session = await runtime.createSession("session");
  const blocker = database.writer.run(async () => {
    writerStarted();
    await new Promise((resolve) => { releaseWriter = resolve; });
  });
  await writerReady;
  const starting = runtime.startRun(session.id, "close during admission");
  const closing = runtime.close();
  releaseWriter();
  await blocker;
  const execution = await starting;
  const run = await execution.completion;
  await closing;
  assert.equal(run.status, "cancelled");
});

test("subscriber failure cannot interrupt admitted run execution", async () => {
  const runtime = createTestRuntime(providerFrom(async () => ({
    content: [{ type: "text", role: "assistant", text: "completed despite observer" }],
  })));
  const unsubscribe = runtime.subscribe(() => {});
  const session = await runtime.createSession("session");
  unsubscribe();
  let failedEventId;
  runtime.subscribe((event) => {
    failedEventId = event.id;
    throw new Error("observer failed");
  });
  const execution = await runtime.startRun(session.id, "continue after observer failure");
  assert.equal((await execution.completion).status, "completed");
  const replayed = [];
  runtime.subscribe((event) => replayed.push(event));
  assert.equal(replayed.some((event) => event.id === failedEventId && event.type === "run.started"), true);
  await runtime.close();
});

test("runtime redacts transform configuration and decisions before inspection", async () => {
  const transform = { id: "test.secret-transform", version: "1", configuration: { token: "secret-value" },
    transform({ content }) { return { content, decisions: [
      { action: "observe", reason: "test", token: "decision-secret" },
    ] }; } };
  const runtime = createTestRuntime(providerFrom(async () => ({ content: [] })), [], {
    contextTransforms: [transform],
  });
  assert.equal(runtime.capabilities().contextTransforms[0].configuration.token, "[redacted]");
  const session = await runtime.createSession("redaction-session");
  const run = await runtime.run(session.id, "redact context metadata");
  const [attempt] = runtime.getModelAttempts(run.id);
  const projection = runtime.getContextProjection(attempt.contextProjectionId);
  assert.equal(projection.transformations[0].configuration.token, "[redacted]");
  assert.equal(projection.transformations[0].decisions[0].token, "[redacted]");
  await runtime.close();
});

test("runtime persists a failed context transform as a failed model attempt", async () => {
  const transform = { id: "test.failing-transform", version: "1", configuration: { mode: "repro" },
    transform({ content }) {
      return { content: [...content,
        { type: "tool-result", callId: "missing", output: "invalid", isError: false }], decisions: [] };
  } };
  const runtime = createTestRuntime(providerFrom(async () => { throw new Error("provider must not run"); }), [], {
    contextTransforms: [transform],
  });
  const session = await runtime.createSession("transform-failure-session");
  const run = await runtime.run(session.id, "fail before provider");
  assert.equal(run.status, "failed");
  const [attempt] = runtime.getModelAttempts(run.id);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error.code, "context.transform");
  assert.equal(attempt.error.transformId, "test.failing-transform");
  assert.equal(attempt.requestArtifactId, undefined);
  const projection = runtime.getContextProjection(attempt.contextProjectionId);
  const contentHash = createHash("sha256").update(JSON.stringify(projection.content)).digest("hex");
  assert.equal(projection.requestHash, contentHash);
  assert.equal(projection.content.some((value) => value.type === "tool-result"), false);
  assert.deepEqual(projection.transformations, [{ id: "test.failing-transform", version: "1", status: "failed",
    configuration: { mode: "repro" }, inputHash: projection.requestHash, outputHash: projection.requestHash, decisions: [],
    error: { code: "context.transform-failed" } }]);
  await runtime.close();
});
