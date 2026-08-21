import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeWorker } from "@car/core";
import { LocalDevelopmentWorker } from "../dist/index.js";
import { workerConformance } from "./worker-conformance.js";

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "car-worker-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "hello.txt"), "hello worker");
  return { root, worker: new LocalDevelopmentWorker({ workspace: "workspace", root, ...options }) };
}
function request(value) {
  return { operationId: "operation", workspace: "workspace", deadline: new Date(Date.now() + 5_000).toISOString(), ...value };
}

workerConformance("local development worker", () => {
  const { root, worker } = fixture();
  return { worker, cleanup: () => rmSync(root, { recursive: true, force: true }) };
});

workerConformance("fake worker", () => {
  const files = new Map([["hello.txt", "hello worker"]]);
  return { worker: new FakeWorker((value) => {
    if (value.workspace !== "workspace") return { ok: false, code: "invalid-scope", message: "scope" };
    if (value.type === "readFile") return { ok: true, output: files.get(value.path) ?? "" };
    if (value.type === "list") return { ok: true, output: [...files.keys()].join("\n") };
    if (value.type === "search") return { ok: true,
      output: value.query === "hello" ? "hello.txt:1:hello worker" : "" };
    if (value.type === "writeFile") { files.set(value.path, value.content); return { ok: true, output: "written" }; }
    if (value.type === "applyPatch") { files.set("patched.txt", "patched worker\n"); return { ok: true, output: "patched" }; }
    if (value.type === "gitStatus") return { ok: true, output: "?? hello.txt" };
    return { ok: true, output: "shell" };
  }) };
});

test("local worker rejects traversal and symlink escape", async () => {
  const { root, worker } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "car-outside-"));
  writeFileSync(join(outside, "secret"), "no");
  symlinkSync(join(outside, "secret"), join(root, "escape"));
  symlinkSync(outside, join(root, "escape-directory"));
  const signal = new AbortController().signal;
  assert.equal((await worker.execute(request({ type: "readFile", path: "../secret" }), signal)).code, "invalid-scope");
  assert.equal((await worker.execute(request({ type: "readFile", path: "escape" }), signal)).code, "invalid-scope");
  assert.equal((await worker.execute(request({ type: "search", query: "no", path: "escape-directory" }), signal)).code, "invalid-scope");
  assert.equal((await worker.execute(request({ type: "writeFile", path: "escape-directory/new", content: "no" }), signal)).code,
    "invalid-scope");
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("local worker enforces deadline, cancellation, and output limit", async () => {
  const { root, worker } = fixture({ maxOutputBytes: 4 });
  assert.equal((await worker.execute({ ...request({ type: "shell", command: "true" }), deadline: new Date(0).toISOString() }, new AbortController().signal)).code, "timeout");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await worker.execute(request({ type: "shell", command: "true" }), controller.signal)).code, "cancelled");
  const runningController = new AbortController();
  const running = worker.execute(request({ type: "shell", command: "sleep 1" }), runningController.signal);
  setTimeout(() => runningController.abort(), 20);
  const cancelled = await running;
  assert.equal(cancelled.code, "cancelled"); assert.equal(cancelled.uncertain, true);
  assert.equal((await worker.execute(request({ type: "readFile", path: "hello.txt" }), new AbortController().signal)).code, "output-limit");
  const timedOut = await worker.execute({ ...request({ type: "shell", command: "sleep 1" }),
    deadline: new Date(Date.now() + 30).toISOString() }, new AbortController().signal);
  assert.equal(timedOut.code, "timeout");
  const tooLarge = await worker.execute(request({ type: "shell", command: "printf 123456789" }), new AbortController().signal);
  assert.equal(tooLarge.code, "output-limit");
  rmSync(root, { recursive: true, force: true });
});
