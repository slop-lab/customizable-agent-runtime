import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("daemon recovers persisted session history after a process restart", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-"));
  const port = await availablePort();
  let daemon = await startDaemon(dataDirectory, port);
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: "POST" });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/sessions?limit=0`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/sessions/missing/runs`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/usage?sessionId=missing`)).status, 404);
  const malformedResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).code, "validation");
  const runResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "persist me" }),
  });
  assert.equal(runResponse.status, 201);
  const run = await runResponse.json();
  assert.equal(run.status, "completed");
  const provenanceResponse = await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/provenance`);
  assert.equal(provenanceResponse.status, 200);
  const provenance = await provenanceResponse.json();
  assert.equal(provenance.manifest.runtime.sourceRevision, "test-revision");
  assert.equal(provenance.manifest.worker.id, "defaults.worker.local-development");
  assert.equal(provenance.manifest.driver.configuration.maximumAttempts, 12);
  assert.equal(provenance.manifest.provider.transport.id, "core.transport.in-process");
  assert.deepEqual(provenance.manifest.tools.map((tool) => tool.id),
    ["apply_patch", "git_status", "list", "read", "search", "shell", "write"]);
  assert.equal(provenance.manifestHash.length, 64);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/runs/missing/provenance`)).status, 404);
  const workerManifestsResponse = await fetch(
    `http://127.0.0.1:${port}/v1/runs/${run.id}/worker-execution-manifests`);
  assert.equal(workerManifestsResponse.status, 200);
  assert.deepEqual(await workerManifestsResponse.json(), []);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/runs/missing/worker-execution-manifests`)).status, 404);
  const sessionsResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions?limit=10`);
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json();
  assert.equal(sessions[0].id, session.id);
  assert.equal(sessions[0].runStatusCounts.completed, 1);
  const runsResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/runs`);
  assert.equal(runsResponse.status, 200);
  const runs = await runsResponse.json();
  assert.equal(runs[0].modelRequestCount, 1);
  assert.equal(runs[0].retryCount, 0);
  const usageResponse = await fetch(`http://127.0.0.1:${port}/v1/usage?sessionId=${session.id}`);
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.totals.modelRequests, 1);
  assert.equal(usage.totals.retries, 0);
  assert.deepEqual(usage.totals.coverage, { normalizedUsage: 0, cost: 0, tokens: {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0,
  } });
  await stopDaemon(daemon, "SIGKILL");

  daemon = await startDaemon(dataDirectory, port);
  const recordsResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/records`);
  assert.equal(recordsResponse.status, 200);
  assert.deepEqual((await recordsResponse.json()).map((record) => record.kind), ["user", "assistant"]);
  await stopDaemon(daemon);
  rmSync(dataDirectory, { recursive: true, force: true });
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startDaemon(dataDirectory, port) {
  const child = spawn(process.execPath, ["--enable-source-maps", "dist/main.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CAR_PROVIDER: "fake", CAR_DATA_DIR: dataDirectory, CAR_PORT: String(port),
      CAR_SOURCE_REVISION: "test-revision" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon start timeout: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CAR daemon listening")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`daemon exited ${code}: ${stderr}`)); });
  });
  return child;
}

async function stopDaemon(child, signal = "SIGTERM") {
  child.kill(signal);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("daemon stop timeout")); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
