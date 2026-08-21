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
