import assert from "node:assert/strict";
import test from "node:test";

export function workerConformance(name, create) {
  test(`${name} satisfies workspace worker conformance`, async () => {
    const { worker, cleanup = () => {} } = create();
    try {
      const signal = new AbortController().signal;
      const base = { operationId: "operation", workspace: "workspace", deadline: new Date(Date.now() + 5_000).toISOString() };
      assert.deepEqual(await worker.execute({ ...base, type: "readFile", path: "hello.txt" }, signal), { ok: true, output: "hello worker" });
      const listed = await worker.execute({ ...base, type: "list", path: "." }, signal);
      assert.equal(listed.ok, true); assert.match(listed.output, /hello\.txt/);
      const searched = await worker.execute({ ...base, type: "search", query: "hello", path: "." }, signal);
      assert.equal(searched.ok, true); assert.match(searched.output, /hello\.txt.*hello worker/);
      assert.equal((await worker.execute({ ...base, type: "search", query: "missing", path: "." }, signal)).output, "");
      assert.equal((await worker.execute({ ...base, type: "writeFile", path: "nested/written.txt",
        content: "written worker" }, signal)).ok, true);
      assert.deepEqual(await worker.execute({ ...base, type: "readFile", path: "nested/written.txt" }, signal),
        { ok: true, output: "written worker" });
      const patch = "diff --git a/patched.txt b/patched.txt\nnew file mode 100644\n--- /dev/null\n+++ b/patched.txt\n" +
        "@@ -0,0 +1 @@\n+patched worker\n";
      assert.equal((await worker.execute({ ...base, type: "applyPatch", patch }, signal)).ok, true);
      assert.deepEqual(await worker.execute({ ...base, type: "readFile", path: "patched.txt" }, signal),
        { ok: true, output: "patched worker\n" });
      assert.deepEqual(await worker.execute({ ...base, type: "shell", command: "printf shell" }, signal), { ok: true, output: "shell" });
      const status = await worker.execute({ ...base, type: "gitStatus" }, signal);
      assert.equal(status.ok, true); assert.match(status.output, /hello\.txt/);
      assert.equal((await worker.execute({ ...base, type: "readFile", path: "hello.txt", workspace: "other" }, signal)).code, "invalid-scope");
    } finally { cleanup(); }
  });
}
