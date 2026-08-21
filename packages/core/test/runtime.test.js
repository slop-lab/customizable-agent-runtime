import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, ToolDispatcher } from "../dist/index.js";

function deterministicSystem() {
  let id = 0;
  let tick = 0;
  return {
    ids: { next: () => `id-${++id}` },
    clock: { now: () => `2026-08-21T00:00:${String(tick++).padStart(2, "0")}.000Z` },
  };
}

test("runtime IDs and timestamps are injectable and deterministic", async () => {
  const provider = {
    id: "fake",
    capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, cancellation: true },
    async *stream() { yield { content: { type: "text", text: "done" } }; },
  };
  const runtime = new Runtime(provider, new ToolDispatcher([]), deterministicSystem());
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(session.id, "id-1");
  assert.equal(session.createdAt, "2026-08-21T00:00:01.000Z");
  assert.equal(run.id, "id-3");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.id), ["id-5", "id-8"]);
});

test("provider failure is recorded deterministically", async () => {
  const provider = {
    id: "fake",
    capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, cancellation: true },
    async *stream() { throw new Error("provider failed"); },
  };
  const runtime = new Runtime(provider, new ToolDispatcher([]), deterministicSystem());
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "failed");
  assert.equal(run.error, "provider failed");
  assert.equal(runtime.getRecords(session.id).at(-1).kind, "error");
});

test("tool dispatch creates a terminal operation", async () => {
  const provider = {
    id: "fake",
    capabilities: { streaming: true, toolCalls: true, parallelToolCalls: false, cancellation: true },
    async *stream() { yield { content: { type: "tool-call", callId: "call", toolName: "effect", input: "value" } }; },
  };
  const tool = { description: { name: "effect", description: "effect" }, async execute(input) { return { output: String(input) }; } };
  const runtime = new Runtime(provider, new ToolDispatcher([tool]), deterministicSystem());
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "completed" }, { kind: "tool", status: "completed" },
  ]);
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "tool-call", "tool-result"]);
});

test("cancellation leaves no post-cancel assistant continuation", async () => {
  const provider = {
    id: "fake",
    capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, cancellation: true },
    async *stream(request) {
      await new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      yield { content: { type: "text", text: "must not appear" } };
    },
  };
  const runtime = new Runtime(provider, new ToolDispatcher([]), deterministicSystem());
  const session = await runtime.createSession("create-session");
  let runId;
  runtime.subscribe((event) => { if (event.type === "run.started") runId = event.data.id; });
  const pending = runtime.run(session.id, "cancel me");
  while (!runId) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.cancelRun(runId), true);
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user"]);
  assert.deepEqual(runtime.getOperations(run.id).map((operation) => operation.status), ["cancelled"]);
});

test("failed tool execution leaves a failed tool operation", async () => {
  const provider = {
    id: "fake",
    capabilities: { streaming: true, toolCalls: true, parallelToolCalls: false, cancellation: true },
    async *stream() { yield { content: { type: "tool-call", callId: "call", toolName: "effect", input: {} } }; },
  };
  const tool = { description: { name: "effect", description: "effect" }, async execute() { throw new Error("uncertain side effect"); } };
  const runtime = new Runtime(provider, new ToolDispatcher([tool]), deterministicSystem());
  const session = await runtime.createSession("create-session");
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "failed");
  assert.deepEqual(runtime.getOperations(run.id).map(({ kind, status }) => ({ kind, status })), [
    { kind: "run", status: "failed" }, { kind: "tool", status: "failed" },
  ]);
});
