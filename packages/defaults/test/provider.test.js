import assert from "node:assert/strict";
import test from "node:test";
import { FakeProvider } from "../dist/index.js";

function request(signal = new AbortController().signal) {
  const requests = []; const events = [];
  return { value: { attemptId: "attempt", context: { id: "context", runId: "run", projectorId: "test",
    projectorVersion: "1", includedRecordIds: [], excludedRecords: [],
    content: [{ type: "text", role: "user", text: "hello" }], createdAt: "now" },
    tools: [], signal, recordRequest: (value) => requests.push(value),
    recordEvent: (type, payload) => events.push({ type, payload }) }, requests, events };
}

test("scripted fake provider emits normalized text and tool calls", async () => {
  const provider = new FakeProvider([{ type: "turn", turn: { content: [
    { type: "text", role: "assistant", text: "hello" },
    { type: "tool-call", callId: "call", toolName: "read", input: {} },
  ] } }]);
  const trace = request();
  const turn = await provider.invoke(trace.value);
  assert.deepEqual(turn.content.map((content) => content.type), ["text", "tool-call"]);
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.events.length, 1);
});

test("scripted fake provider supports failure and cancellation", async () => {
  const failing = new FakeProvider([{ type: "failure", code: "planned", message: "planned failure", retryable: true }]);
  await assert.rejects(() => failing.invoke(request().value), /planned failure/);
  const controller = new AbortController();
  const delayed = new FakeProvider([{ type: "delay", milliseconds: 1_000 }]);
  const pending = delayed.invoke(request(controller.signal).value);
  controller.abort();
  await assert.rejects(pending);
});
