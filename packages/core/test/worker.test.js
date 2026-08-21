import assert from "node:assert/strict";
import test from "node:test";
import { FakeWorker } from "../dist/index.js";

test("fake worker records typed capability requests", async () => {
  const worker = new FakeWorker((request) => ({ ok: true, output: request.type }));
  const request = { type: "readFile", operationId: "op", workspace: "workspace", deadline: "soon", path: "README.md" };
  assert.deepEqual(await worker.execute(request, new AbortController().signal), { ok: true, output: "readFile" });
  assert.deepEqual(worker.requests, [request]);
});
