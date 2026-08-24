import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DefaultContextProjector,
  OldToolResultPruningTransform,
  oldToolResultTombstone,
} from "../dist/index.js";

function toolRecords(count) {
  const records = [{ id: "user", sessionId: "session", runId: "run", kind: "user",
    data: { text: "start" }, createdAt: "now" }];
  for (let index = 1; index <= count; index++) {
    records.push({ id: `call-record-${index}`, sessionId: "session", runId: "run", kind: "tool-call",
      data: { callId: `call-${index}`, toolName: "read", input: { path: `${index}.txt` } }, createdAt: "now" });
    records.push({ id: `result-record-${index}`, sessionId: "session", runId: "run", kind: "tool-result",
      data: { callId: `call-${index}`, output: `payload-${index}`, isError: false }, createdAt: "now" });
  }
  return records;
}

test("old tool results are replaced in stable batches without mutating records", () => {
  const records = toolRecords(29);
  const projector = new DefaultContextProjector();
  const projection = projector.project("context", "run", records, "now", {
    attemptNumber: 4,
    transforms: [new OldToolResultPruningTransform()],
  });
  const results = projection.content.filter((value) => value.type === "tool-result");
  assert.deepEqual(results.slice(0, 10).map((value) => value.output), Array(10).fill(oldToolResultTombstone));
  assert.deepEqual(results.slice(10).map((value) => value.output),
    Array.from({ length: 19 }, (_, index) => `payload-${index + 11}`));
  assert.equal(projection.transformations.length, 1);
  assert.equal(projection.transformations[0].status, "applied");
  assert.equal(projection.transformations[0].decisions.length, 10);
  assert.equal(projection.transformations[0].decisions[0].callId, "call-1");
  assert.equal(projection.transformations[0].inputHash.length, 64);
  assert.equal(projection.transformations[0].outputHash, projection.requestHash);
  assert.equal(records[2].data.output, "payload-1");

  const advanced = projector.project("next", "run", toolRecords(30), "now", {
    transforms: [new OldToolResultPruningTransform()],
  });
  assert.equal(advanced.transformations[0].decisions.length, 20);
});

test("tool-result pruning protects errors, named tools, and recent exchanges", () => {
  const records = toolRecords(20);
  records[2] = { ...records[2], data: { ...records[2].data, isError: true } };
  records[3] = { ...records[3], data: { ...records[3].data, toolName: "skill" } };
  const projection = new DefaultContextProjector().project("context", "run", records, "now", {
    transforms: [new OldToolResultPruningTransform({ minimumCompletedToolExchanges: 18,
      retainRecentToolExchanges: 8, pruneBatchSize: 10 })],
  });
  const results = projection.content.filter((value) => value.type === "tool-result");
  assert.equal(results[0].output, "payload-1");
  assert.equal(results[1].output, "payload-2");
  assert.equal(projection.transformations[0].decisions.length, 10);
  assert.deepEqual(projection.transformations[0].decisions.map((value) => value.callId),
    Array.from({ length: 10 }, (_, index) => `call-${index + 3}`));
});

test("context transforms cannot leave an orphan tool result", () => {
  const invalid = { id: "test.invalid", version: "1", transform({ content }) {
    return { content: content.filter((value) => value.type !== "tool-call"), decisions: [] };
  } };
  assert.throws(() => new DefaultContextProjector().project("context", "run", toolRecords(1), "now",
    { transforms: [invalid] }), (error) => error.name === "ContextTransformFailure" &&
      /no preceding call/.test(error.cause.message));
});

test("context transform input mutation cannot corrupt a failed projection", () => {
  const mutating = { id: "test.mutating", version: "1", transform({ content }) {
    content[0].text = "tampered";
    throw new Error("after mutation");
  } };
  let failure;
  try {
    new DefaultContextProjector().project("context", "run", toolRecords(0), "now", { transforms: [mutating] });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.name, "ContextTransformFailure");
  assert.equal(failure.projection.content[0].text, "start");
  const hash = createHash("sha256").update(JSON.stringify(failure.projection.content)).digest("hex");
  assert.equal(failure.projection.requestHash, hash);
  assert.equal(failure.projection.transformations[0].outputHash, hash);
});

test("context rejects tool-call IDs reused after a completed exchange", () => {
  const records = toolRecords(2);
  records[3] = { ...records[3], data: { ...records[3].data, callId: "call-1" } };
  records[4] = { ...records[4], data: { ...records[4].data, callId: "call-1" } };
  assert.throws(() => new DefaultContextProjector().project("context", "run", records, "now"),
    /Duplicate tool call ID/);
});
