import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDevelopmentWorker } from "../dist/index.js";

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "car-worker-"));
  writeFileSync(join(root, "hello.txt"), "hello worker");
  return { root, worker: new LocalDevelopmentWorker({ workspace: "workspace", root, ...options }) };
}
function request(value) {
  return { operationId: "operation", workspace: "workspace", deadline: new Date(Date.now() + 5_000).toISOString(), ...value };
}

test("local worker reads and shells only through its workspace capability", async () => {
  const { root, worker } = fixture();
  const signal = new AbortController().signal;
  assert.deepEqual(await worker.execute(request({ type: "readFile", path: "hello.txt" }), signal), { ok: true, output: "hello worker" });
  const shell = await worker.execute(request({ type: "shell", command: "printf shell" }), signal);
  assert.deepEqual(shell, { ok: true, output: "shell" });
  assert.equal((await worker.execute({ ...request({ type: "readFile", path: "hello.txt" }), workspace: "other" }, signal)).code, "invalid-scope");
  rmSync(root, { recursive: true, force: true });
});

test("local worker rejects traversal and symlink escape", async () => {
  const { root, worker } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "car-outside-"));
  writeFileSync(join(outside, "secret"), "no");
  symlinkSync(join(outside, "secret"), join(root, "escape"));
  const signal = new AbortController().signal;
  assert.equal((await worker.execute(request({ type: "readFile", path: "../secret" }), signal)).code, "invalid-scope");
  assert.equal((await worker.execute(request({ type: "readFile", path: "escape" }), signal)).code, "invalid-scope");
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("local worker enforces deadline, cancellation, and output limit", async () => {
  const { root, worker } = fixture({ maxOutputBytes: 4 });
  assert.equal((await worker.execute({ ...request({ type: "shell", command: "true" }), deadline: new Date(0).toISOString() }, new AbortController().signal)).code, "timeout");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await worker.execute(request({ type: "shell", command: "true" }), controller.signal)).code, "cancelled");
  assert.equal((await worker.execute(request({ type: "readFile", path: "hello.txt" }), new AbortController().signal)).code, "output-limit");
  rmSync(root, { recursive: true, force: true });
});
