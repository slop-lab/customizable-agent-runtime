import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("daemon recovers persisted session history after a process restart", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-"));
  const port = await availablePort();
  let daemon = await startDaemon(dataDirectory, port);
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  const webResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(webResponse.status, 200);
  assert.match(webResponse.headers.get("content-type"), /^text\/html/);
  assert.match(await webResponse.text(), /<title>CAR<\/title>/);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/v1/plugins`)).json(), []);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).json()).plugins, []);
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
  assert.equal(runResponse.status, 202);
  const acceptedRun = await runResponse.json();
  assert.equal(acceptedRun.status, "running");
  const run = await waitForRun(port, acceptedRun.id);
  assert.equal(run.status, "completed");
  const provenanceResponse = await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/provenance`);
  assert.equal(provenanceResponse.status, 200);
  const provenance = await provenanceResponse.json();
  assert.equal(provenance.manifest.version, 2);
  assert.equal(provenance.manifest.runtime.sourceRevision, "test-revision");
  assert.equal(provenance.manifest.worker.id, "defaults.worker.local-development");
  assert.equal(provenance.manifest.driver.configuration.maximumAttempts, 12);
  assert.equal(provenance.manifest.provider.transport.id, "core.transport.in-process");
  assert.deepEqual(provenance.manifest.contextTransforms.map((transform) => transform.id),
    ["core.context.old-tool-results"]);
  assert.deepEqual(provenance.manifest.tools.map((tool) => tool.id),
    ["apply_patch", "bash", "edit", "git_diff", "git_status", "glob", "grep", "list", "read", "search",
      "shell", "write"]);
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
  const attempts = await (await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/attempts`)).json();
  const projection = await (await fetch(`http://127.0.0.1:${port}/v1/context-projections/${attempts[0].contextProjectionId}`)).json();
  assert.equal(projection.transformations[0].id, "core.context.old-tool-results");
  assert.deepEqual(projection.transformations[0].decisions, []);
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

test("daemon composes explicitly selected Gitea plugin and exposes bounded health", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-plugin-"));
  const daemonPort = await availablePort();
  let observedAuthorization;
  const gitea = createHttpServer((request, response) => {
    observedAuthorization = request.headers.authorization;
    assert.equal(request.url, "/api/v1/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "test" }));
  });
  await new Promise((resolve) => gitea.listen(0, "127.0.0.1", resolve));
  const address = gitea.address();
  assert.equal(typeof address, "object");
  const daemon = await startDaemon(dataDirectory, daemonPort, { CAR_PLUGINS: "gitea",
    CAR_GITEA_URL: `http://127.0.0.1:${address.port}`, CAR_GITEA_CREDENTIAL_HANDLE: "env:TEST_GITEA_TOKEN",
    TEST_GITEA_TOKEN: "test-secret" });
  try {
    const capabilities = await (await fetch(`http://127.0.0.1:${daemonPort}/v1/capabilities`)).json();
    assert.deepEqual(capabilities.plugins, [{ id: "integration.gitea", version: "1", dependencies: [] }]);
    assert.deepEqual(capabilities.tools.filter((tool) => tool.name.startsWith("integration.gitea."))
      .map((tool) => tool.name), ["integration.gitea.repository.get", "integration.gitea.pull.get"]);
    const inspection = await (await fetch(`http://127.0.0.1:${daemonPort}/v1/plugins`)).json();
    assert.deepEqual(inspection, [{ id: "integration.gitea", version: "1", dependencies: [], state: "ready",
      health: { status: "ready" } }]);
    assert.equal(observedAuthorization, "token test-secret");
  } finally {
    await stopDaemon(daemon);
    await new Promise((resolve, reject) => gitea.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("daemon composes one explicitly configured remote MCP plugin", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-mcp-"));
  const daemonPort = await availablePort();
  const observed = [];
  const mcp = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    observed.push({ method: body?.method, authorization: request.headers.authorization });
    if (request.method === "GET") { response.writeHead(405); response.end(); return; }
    if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
    if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    if (body.method === "server/discover") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        error: { code: -32601, message: "Method not found" } }));
      return;
    }
    const result = body.method === "initialize"
      ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "daemon-fixture", version: "1" } }
      : body.method === "tools/list"
        ? { tools: [{ name: "issues.get", description: "Get an issue",
          inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
        : body.method === "ping" ? {} : undefined;
    assert.notEqual(result, undefined, `Unexpected MCP method: ${body.method}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  const address = mcp.address();
  assert.equal(typeof address, "object");
  const daemon = await startDaemon(dataDirectory, daemonPort, { CAR_PLUGINS: "mcp",
    CAR_MCP_SERVER_ID: "fixture", CAR_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
    CAR_MCP_ALLOWED_TOOLS: "issues.get", CAR_MCP_CREDENTIAL_HANDLE: "env:TEST_MCP_TOKEN",
    TEST_MCP_TOKEN: "mcp-secret" });
  try {
    const capabilities = await (await fetch(`http://127.0.0.1:${daemonPort}/v1/capabilities`)).json();
    assert.deepEqual(capabilities.plugins, [{ id: "integration.mcp.fixture", version: "1", dependencies: [] }]);
    assert.deepEqual(capabilities.tools.filter((tool) => tool.name.startsWith("integration.mcp."))
      .map((tool) => tool.name), ["integration.mcp.fixture.issues-get"]);
    const inspection = await (await fetch(`http://127.0.0.1:${daemonPort}/v1/plugins`)).json();
    assert.deepEqual(inspection, [{ id: "integration.mcp.fixture", version: "1", dependencies: [], state: "ready",
      health: { status: "ready", message: "Connected to daemon-fixture@1" } }]);
    assert.deepEqual(observed.filter((request) => request.method).map((request) => request.method),
      ["server/discover", "initialize", "notifications/initialized", "tools/list", "ping"]);
    assert.ok(observed.every((request) => request.authorization === "Bearer mcp-secret"));
  } finally {
    await stopDaemon(daemon);
    await new Promise((resolve, reject) => mcp.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("daemon exposes a durable adaptive review workflow through HTTP and the web UI", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-review-"));
  const port = await availablePort();
  const head = "a".repeat(40);
  let daemon = await startDaemon(dataDirectory, port);
  try {
    const web = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(web, /Review workflows/);
    assert.match(web, /Create workflow/);
    assert.match(web, /workflowBusy/);
    assert.match(web, /stage\.evidence\.acceptedSourceKinds/);
    assert.match(web, /authoritativeKinds/);
    const capabilities = await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).json();
    assert.deepEqual(capabilities.reviewWorkflowProviders, [
      { id: "core.review.adaptive", version: "1" },
      { id: "core.review.declarative", version: "1" },
    ]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/review-workflows`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "null",
    })).status, 400);
    let snapshot = await jsonRequest(port, "/v1/review-workflows", {
      method: "POST", body: { projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head },
      expectedStatus: 201,
    });
    const workflowId = snapshot.workflow.id;
    const stageEvidence = {
      "base-protection": { type: "git.base.protected", source: { kind: "git-host", id: "gitea" } },
      implementation: { type: "implementation.completed", source: { kind: "agent", id: "implementer" } },
      "pull-request": { type: "git.pull-request.opened", source: { kind: "git-host", id: "gitea" } },
      "automated-checks": { type: "check.passed", source: { kind: "ci", id: "verify" } },
      "security-review": { type: "review.agent.approved", source: { kind: "agent", id: "security" } },
      "code-review": { type: "review.agent.approved", source: { kind: "agent", id: "reviewer" } },
      "human-approval": { type: "review.human.approved", source: { kind: "human", id: "alice" } },
    };
    for (const stageId of ["base-protection", "implementation", "pull-request", "automated-checks"]) {
      snapshot = await completeReviewStage(port, snapshot, stageId, { ...stageEvidence[stageId], commitSha: head });
    }
    snapshot = await jsonRequest(port, `/v1/review-workflows/${workflowId}/evidence`, { method: "POST", body: {
      expectedRevision: snapshot.workflow.currentRevision,
      evidence: { externalEventId: "daemon-risk", type: "risk.detected", commitSha: head,
        source: { kind: "tool", id: "classifier" },
        payload: { category: "security" } },
    } });
    assert.equal(snapshot.current.plan.stages.some((stage) => stage.id === "security-review"), true);
    const blocked = await jsonRequest(port, `/v1/review-workflows/${workflowId}/stages/code-review/complete`, {
      method: "POST", body: { expectedRevision: snapshot.workflow.currentRevision,
        evidence: { externalEventId: "daemon-blocked-review", ...stageEvidence["code-review"], commitSha: head } },
      expectedStatus: 409,
    });
    assert.equal(blocked.code, "conflict");
    const unchanged = await jsonRequest(port, `/v1/review-workflows/${workflowId}`);
    assert.equal(unchanged.workflow.currentRevision, snapshot.workflow.currentRevision);
    assert.equal(unchanged.historyCounts.evidence, snapshot.historyCounts.evidence);

    for (const stageId of ["security-review", "code-review", "human-approval"]) {
      snapshot = await completeReviewStage(port, snapshot, stageId, { ...stageEvidence[stageId], commitSha: head });
    }
    assert.equal(snapshot.mergeReadiness.ready, true);
    assert.equal(snapshot.mergeReadiness.publishable, false);
    assert.equal((await jsonRequest(port, "/v1/review-workflows?limit=10"))[0].workflow.id, workflowId);
    await stopDaemon(daemon, "SIGKILL");

    daemon = await startDaemon(dataDirectory, port);
    snapshot = await jsonRequest(port, `/v1/review-workflows/${workflowId}`);
    assert.equal(snapshot.mergeReadiness.ready, true);
    assert.equal(snapshot.historyCounts.revisions, snapshot.workflow.currentRevision);
    const history = await jsonRequest(port, `/v1/review-workflows/${workflowId}/history?limit=2`);
    assert.equal(history.revisions.length, 2);
    assert.equal(typeof history.nextBeforeRevision, "number");
    const nextHead = "b".repeat(40);
    snapshot = await jsonRequest(port, `/v1/review-workflows/${workflowId}/head`, { method: "POST", body: {
      expectedRevision: snapshot.workflow.currentRevision, headSha: nextHead, externalEventId: "daemon-head-change",
      source: { kind: "human", id: "alice" },
    } });
    assert.equal(snapshot.workflow.headSha, nextHead);
    assert.equal(snapshot.mergeReadiness.ready, false);
    assert.equal(snapshot.stages.every((stage) => stage.state !== "completed"), true);

    const declarativeStages = [
      { id: "base", label: "Base", kind: "protected-base", required: true, dependsOn: [],
        evidence: { type: "git.base.protected", acceptedSourceKinds: ["git-host"] } },
      { id: "team:implementation", label: "Team implementation", kind: "implementation", required: true, dependsOn: [],
        evidence: { type: "implementation.completed", acceptedSourceKinds: ["agent"] } },
      { id: "pull", label: "PR", kind: "pull-request", required: true, dependsOn: ["team:implementation"],
        evidence: { type: "git.pull-request.opened", acceptedSourceKinds: ["git-host"] } },
      { id: "approval", label: "Approval", kind: "human-approval", required: true, dependsOn: ["base", "pull"],
        evidence: { type: "review.human.approved", acceptedSourceKinds: ["human"] } },
    ];
    let declarative = await jsonRequest(port, "/v1/review-workflows", { method: "POST", expectedStatus: 201, body: {
      projectId: "colon", repository: "dim/colon", baseBranch: "main", headSha: head,
      provider: { id: "core.review.declarative", configuration: { stages: declarativeStages } },
    } });
    declarative = await jsonRequest(port, `/v1/review-workflows/${declarative.workflow.id}/stages/team%3Aimplementation/complete`, {
      method: "POST", body: { expectedRevision: declarative.workflow.currentRevision,
        evidence: { externalEventId: "colon-stage", type: "implementation.completed", commitSha: head,
          source: { kind: "agent", id: "team" }, payload: {} } },
    });
    assert.equal(declarative.stages.find((stage) => stage.stage.id === "team:implementation").state, "completed");
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/review-workflows/%E0%A4%A`)).status, 400);
  } finally {
    if (daemon.exitCode === null) await stopDaemon(daemon);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("daemon rejects cross-origin, rebinding, non-JSON, and oversized mutation requests", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "car-daemon-authority-"));
  const port = await availablePort();
  const daemon = await startDaemon(dataDirectory, port);
  const endpoint = `http://127.0.0.1:${port}/v1/sessions`;
  try {
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers: {
      "content-type": "application/json", origin: "https://evil.example",
    }, body: "{}" })).status, 400);
    assert.equal(await rawStatus(port, "/health", { host: "evil.example" }), 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(129 * 1024) }) })).status, 400);
    const allowed = await fetch(endpoint, { method: "POST", headers: {
      "content-type": "application/json", origin: `http://127.0.0.1:${port}`,
    }, body: "{}" });
    assert.equal(allowed.status, 201);
  } finally {
    await stopDaemon(daemon);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startDaemon(dataDirectory, port, environment = {}) {
  const child = spawn(process.execPath, ["--enable-source-maps", "dist/main.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CAR_PROVIDER: "fake", CAR_PLUGINS: "", CAR_DATA_DIR: dataDirectory, CAR_PORT: String(port),
      CAR_SOURCE_REVISION: "test-revision", ...environment },
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

async function waitForRun(port, runId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await (await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}`)).json();
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run did not finish: ${runId}`);
}

async function jsonRequest(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  assert.equal(response.status, options.expectedStatus ?? 200, `${response.status} ${path}: ${await response.clone().text()}`);
  return response.json();
}

async function rawStatus(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

async function completeReviewStage(port, snapshot, stageId, stageEvidence) {
  return jsonRequest(port, `/v1/review-workflows/${snapshot.workflow.id}/stages/${stageId}/complete`, {
    method: "POST", body: { expectedRevision: snapshot.workflow.currentRevision,
      evidence: { externalEventId: `daemon-stage-${stageId}`, ...stageEvidence } },
  });
}
