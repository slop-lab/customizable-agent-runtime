#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDirectory = mkdtempSync(join(tmpdir(), "car-review-smoke-"));
const head = "a".repeat(40);
const nextHead = "b".repeat(40);
const port = await availablePort();
let daemon;

try {
  daemon = await startDaemon();
  const health = await request("/health");
  assert.deepEqual(health, { status: "ok" });
  const html = await (await fetch(baseUrl())).text();
  assert.match(html, /Review workflows/);

  let snapshot = await request("/v1/review-workflows", "POST", {
    projectId: "container-smoke",
    repository: "local/container-smoke",
    baseBranch: "main",
    headSha: head,
  }, 201);
  const id = snapshot.workflow.id;
  snapshot = await complete(snapshot, "base-protection", "git.base.protected", "git-host", "fixture-git");
  snapshot = await complete(snapshot, "implementation", "implementation.completed", "agent", "fixture-implementer");
  snapshot = await complete(snapshot, "pull-request", "git.pull-request.opened", "git-host", "fixture-git");
  snapshot = await complete(snapshot, "automated-checks", "check.passed", "ci", "fixture-ci");

  snapshot = await request(`/v1/review-workflows/${id}/evidence`, "POST", {
    expectedRevision: snapshot.workflow.currentRevision,
    evidence: { externalEventId: "smoke-risk", type: "risk.detected", commitSha: head,
      source: { kind: "tool", id: "fixture-classifier" },
      payload: { category: "security" } },
  });
  assert.equal(snapshot.current.plan.stages.some((stage) => stage.id === "security-review"), true);
  const blocked = await request(`/v1/review-workflows/${id}/stages/code-review/complete`, "POST", {
    expectedRevision: snapshot.workflow.currentRevision,
    evidence: { externalEventId: "smoke-blocked-review", type: "review.agent.approved", commitSha: head,
      source: { kind: "agent", id: "fixture-reviewer" }, payload: {} },
  }, 409);
  assert.equal(blocked.code, "conflict");

  snapshot = await complete(snapshot, "security-review", "review.agent.approved", "agent", "fixture-security");
  snapshot = await complete(snapshot, "code-review", "review.agent.approved", "agent", "fixture-reviewer");
  snapshot = await complete(snapshot, "human-approval", "review.human.approved", "human", "fixture-human");
  assert.equal(snapshot.mergeReadiness.ready, true);
  assert.equal(snapshot.mergeReadiness.publishable, false);
  const readyRevision = snapshot.workflow.currentRevision;

  await stopDaemon(daemon);
  daemon = await startDaemon();
  snapshot = await request(`/v1/review-workflows/${id}`);
  assert.equal(snapshot.workflow.currentRevision, readyRevision);
  assert.equal(snapshot.mergeReadiness.ready, true);
  snapshot = await request(`/v1/review-workflows/${id}/head`, "POST", {
    expectedRevision: snapshot.workflow.currentRevision,
    headSha: nextHead,
    externalEventId: "smoke-head-change",
    source: { kind: "human", id: "fixture-human" },
  });
  assert.equal(snapshot.mergeReadiness.ready, false);
  assert.equal(snapshot.stages.every((stage) => stage.state !== "completed"), true);

  process.stdout.write(`${JSON.stringify({ status: "ok", workflowId: id, readyRevision,
    invalidatedRevision: snapshot.workflow.currentRevision, revisions: snapshot.historyCounts.revisions,
    evidence: snapshot.historyCounts.evidence })}\n`);
} finally {
  if (daemon?.exitCode === null) await stopDaemon(daemon);
  rmSync(dataDirectory, { recursive: true, force: true });
}

async function complete(snapshot, stageId, type, kind, sourceId) {
  return request(`/v1/review-workflows/${snapshot.workflow.id}/stages/${stageId}/complete`, "POST", {
    expectedRevision: snapshot.workflow.currentRevision,
    evidence: { externalEventId: `smoke-stage-${stageId}`, type, commitSha: snapshot.workflow.headSha,
      source: { kind, id: sourceId }, payload: { stageId } },
  });
}

function baseUrl(path = "") { return `http://127.0.0.1:${port}${path}`; }

async function request(path, method = "GET", body, expectedStatus = 200) {
  const response = await fetch(baseUrl(path), {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${response.status} ${path}: ${text}`);
  return JSON.parse(text);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const value = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

async function startDaemon() {
  const child = spawn(process.execPath, ["--enable-source-maps", "apps/daemon/dist/main.js"], {
    cwd: root,
    env: { ...process.env, CAR_PROVIDER: "fake", CAR_PLUGINS: "", CAR_DATA_DIR: dataDirectory,
      CAR_HOST: "127.0.0.1", CAR_PORT: String(port), CAR_SOURCE_REVISION: "container-smoke" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon start timeout: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CAR daemon listening")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`daemon exited ${code}: ${stderr}`)); });
  });
  return child;
}

async function stopDaemon(child) {
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("daemon stop timeout")); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
