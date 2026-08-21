import assert from "node:assert/strict";
import test from "node:test";

export function workerConformance(name, create) {
  test(`${name} satisfies read/shell worker conformance`, async () => {
    const { worker, cleanup = () => {} } = create();
    try {
      const signal = new AbortController().signal;
      const base = { operationId: "operation", workspace: "workspace", deadline: new Date(Date.now() + 5_000).toISOString() };
      assert.deepEqual(await worker.execute({ ...base, type: "readFile", path: "hello.txt" }, signal), { ok: true, output: "hello worker" });
      assert.deepEqual(await worker.execute({ ...base, type: "shell", command: "printf shell" }, signal), { ok: true, output: "shell" });
      assert.equal((await worker.execute({ ...base, type: "readFile", path: "hello.txt", workspace: "other" }, signal)).code, "invalid-scope");
    } finally { cleanup(); }
  });
}
