import assert from "node:assert/strict";
import test from "node:test";
import { FakeProvider } from "../dist/index.js";

function request(signal = new AbortController().signal) {
  return { sessionId: "session", runId: "run", records: [], tools: [], signal };
}

test("scripted fake provider emits text and tool calls sequentially", async () => {
  const provider = new FakeProvider([
    { type: "chunk", chunk: { content: { type: "text", text: "hello" } } },
    { type: "chunk", chunk: { content: { type: "tool-call", callId: "call", toolName: "read", input: {} } } },
  ]);
  const chunks = [];
  for await (const chunk of provider.stream(request())) chunks.push(chunk);
  assert.deepEqual(chunks.map((chunk) => chunk.content.type), ["text", "tool-call"]);
});

test("scripted fake provider supports failure and cancellation", async () => {
  const failing = new FakeProvider([{ type: "failure", message: "planned failure" }]);
  await assert.rejects(async () => { for await (const _chunk of failing.stream(request())) {} }, /planned failure/);
  const controller = new AbortController();
  const delayed = new FakeProvider([{ type: "delay", milliseconds: 1_000 }]);
  const pending = (async () => { for await (const _chunk of delayed.stream(request(controller.signal))) {} })();
  controller.abort();
  await assert.rejects(pending);
});
