import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactIngressStore } from "@car/core";
import { createDefaultRuntime, ProcessIsolatedWorker } from "../dist/index.js";
import { workerConformance } from "./worker-conformance.js";

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "car-isolated-worker-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "hello.txt"), "hello worker");
  const ingress = new ArtifactIngressStore(join(root, ".ingress"), 4_096);
  const worker = new ProcessIsolatedWorker({ workspace: "workspace", root, artifactIngress: ingress,
    maximumInlineOutputBytes: 1_024, maximumArtifactBytes: 4_096, ...options });
  return { root, worker };
}
function request(value) {
  return { operationId: "operation", workspace: "workspace",
    deadline: new Date(Date.now() + 5_000).toISOString(), ...value };
}

workerConformance("process-isolated worker", () => {
  const { root, worker } = fixture();
  return { worker, cleanup: () => { worker.close(); rmSync(root, { recursive: true, force: true }); } };
});

test("process worker issues child-produced manifests and replaces expired leases", async () => {
  const secret = "must-not-appear-in-manifest";
  const { root, worker } = fixture({ leaseTtlMs: 120,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", SAFE_MARKER: secret } });
  try {
    const first = await worker.execute(request({ type: "readFile", path: "hello.txt" }), new AbortController().signal);
    assert.equal(first.ok, true);
    assert.equal(first.lease.id, first.executionManifest.leaseId);
    assert.equal(first.executionManifest.manifest.worker.id, "defaults.worker.process-isolated");
    assert.deepEqual(first.executionManifest.manifest.environment.keys, ["PATH", "SAFE_MARKER"]);
    const serialized = JSON.stringify(first.executionManifest);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(secret), false);

    await new Promise((resolve) => setTimeout(resolve, 75));
    const renewed = await worker.execute(request({ type: "readFile", path: "hello.txt" }),
      new AbortController().signal);
    assert.equal(renewed.ok, true);
    assert.equal(renewed.lease.id, first.lease.id);
    assert.ok(Date.parse(renewed.lease.expiresAt) > Date.parse(first.lease.expiresAt));

    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal((await worker.reconcile()).state, "idle");
    const second = await worker.execute(request({ type: "readFile", path: "hello.txt" }), new AbortController().signal);
    assert.equal(second.ok, true);
    assert.notEqual(second.lease.id, first.lease.id);
    assert.equal(worker.lifecycle().restarts, 1);
  } finally { worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("process disappearance marks side-effect results uncertain and the next request reconciles", async () => {
  const { root, worker } = fixture();
  try {
    const crashed = await worker.execute(request({ type: "shell", command: "kill -9 $PPID" }),
      new AbortController().signal);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.code, "worker-failed");
    assert.equal(crashed.uncertain, true);
    const recovered = await worker.execute(request({ type: "readFile", path: "hello.txt" }),
      new AbortController().signal);
    assert.equal(recovered.ok, true);
    assert.equal(worker.lifecycle().restarts, 1);
  } finally { worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("process worker propagates cancellation into a running child command", async () => {
  const { root, worker } = fixture();
  try {
    const controller = new AbortController();
    const running = worker.execute(request({ type: "shell", command: "sleep 1" }), controller.signal);
    setTimeout(() => controller.abort(), 30);
    const response = await running;
    assert.equal(response.ok, false);
    assert.equal(response.code, "cancelled");
    assert.equal(response.uncertain, true);
  } finally { worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("default runtime persists the process worker manifest without projecting it to the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "car-isolated-runtime-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "hello.txt"), "hello runtime");
  const contexts = [];
  let invocation = 0;
  const provider = { id: "isolated-provider", profile: { id: "isolated", provider: "fake", model: "isolated",
    endpoint: "fake://isolated", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.tools.calls": { supported: true } } }, async invoke(requestValue) {
      contexts.push(requestValue.context.content);
      requestValue.recordRequest({});
      invocation++;
      const turn = invocation === 1
        ? { content: [{ type: "tool-call", callId: "call", toolName: "read", input: { path: "hello.txt" } }] }
        : { content: [{ type: "text", role: "assistant", text: "done" }], finishReason: "completed" };
      requestValue.recordEvent("completed", turn);
      return turn;
    } };
  let runtime = createDefaultRuntime({ provider, workspace: "workspace", workspaceRoot: root,
    workerBackend: "isolated-process", databasePath: join(root, "runtime.sqlite"),
    artifactRoot: join(root, "artifacts") });
  try {
    const session = await runtime.createSession("session");
    const run = await runtime.run(session.id, "read");
    assert.equal(run.status, "completed");
    const manifests = runtime.getRunWorkerExecutionManifests(run.id);
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].manifest.worker.id, "defaults.worker.process-isolated");
    const projected = contexts[1].find((content) => content.type === "tool-result");
    assert.deepEqual(projected, { type: "tool-result", callId: "call", output: "hello runtime", isError: false });
    runtime.close();
    runtime = createDefaultRuntime({ provider, workspace: "workspace", workspaceRoot: root,
      workerBackend: "isolated-process", databasePath: join(root, "runtime.sqlite"),
      artifactRoot: join(root, "artifacts") });
    assert.deepEqual(runtime.getRunWorkerExecutionManifests(run.id), manifests);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
