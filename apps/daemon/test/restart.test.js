import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
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
  assert.equal(provenance.manifest.runtime.sourceRevision, "test-revision");
  assert.equal(provenance.manifest.worker.id, "defaults.worker.local-development");
  assert.equal(provenance.manifest.driver.configuration.maximumAttempts, 12);
  assert.equal(provenance.manifest.provider.transport.id, "core.transport.in-process");
  assert.deepEqual(provenance.manifest.contextTransforms.map((transform) => transform.id),
    ["core.context.old-tool-results"]);
  assert.deepEqual(provenance.manifest.tools.map((tool) => tool.id),
    ["apply_patch", "bash", "edit", "git_diff", "git_status", "glob", "grep", "list", "read", "search",
      "shell", "web_fetch", "write"]);
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
