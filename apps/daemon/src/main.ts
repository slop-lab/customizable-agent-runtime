#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultRuntime, createProviderFromEnvironment } from "@car/defaults";
import { RuntimeError } from "@car/core";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const environmentFile = join(repositoryRoot, ".env");
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const dataDirectory = process.env.CAR_DATA_DIR ?? join(repositoryRoot, ".car");
mkdirSync(dataDirectory, { recursive: true });
const runtime = createDefaultRuntime({ databasePath: join(dataDirectory, "runtime.sqlite"),
  artifactRoot: join(dataDirectory, "artifacts"), workspaceRoot: repositoryRoot,
  provider: createProviderFromEnvironment() });
const host = process.env.CAR_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CAR_PORT ?? "4317", 10);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (error instanceof RuntimeError) {
      const status = error.code === "not-found" ? 404 : error.code === "validation" ? 400
        : error.code === "conflict" ? 409 : error.code === "cancelled" ? 409 : 500;
      send(response, status, { error: error.message, code: error.code }); return;
    }
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    send(response, 200, runtime.capabilities());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/usage") {
    const sessionId = optionalParameter(url, "sessionId");
    const runId = optionalParameter(url, "runId");
    send(response, 200, runtime.usage({ ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    send(response, 201, await runtime.createSession());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/sessions") {
    const limit = readLimit(url);
    if (limit === undefined) { send(response, 400, { error: "limit must be an integer from 1 through 100" }); return; }
    send(response, 200, runtime.listSessions({ limit }));
    return;
  }

  const recordsMatch = /^\/v1\/sessions\/([^/]+)\/records$/.exec(url.pathname);
  if (request.method === "GET" && recordsMatch?.[1]) {
    send(response, 200, runtime.getRecords(recordsMatch[1]));
    return;
  }

  const runsMatch = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(url.pathname);
  if (request.method === "GET" && runsMatch?.[1]) {
    const limit = readLimit(url);
    if (limit === undefined) { send(response, 400, { error: "limit must be an integer from 1 through 100" }); return; }
    if (!runtime.getSession(runsMatch[1])) { send(response, 404, { error: "Session not found" }); return; }
    send(response, 200, runtime.listRuns(runsMatch[1], { limit }));
    return;
  }
  if (request.method === "POST" && runsMatch?.[1]) {
    const body = await readJson(request);
    if (!isRunBody(body)) {
      send(response, 400, { error: "Expected JSON body with a string input." });
      return;
    }
    send(response, 201, await runtime.run(runsMatch[1], body.input));
    return;
  }

  const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelMatch?.[1]) {
    send(response, runtime.cancelRun(cancelMatch[1]) ? 202 : 404, {});
    return;
  }

  const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && runMatch?.[1]) {
    const run = runtime.getRun(runMatch[1]);
    send(response, run ? 200 : 404, run ?? { error: "Run not found" });
    return;
  }

  const operationsMatch = /^\/v1\/runs\/([^/]+)\/operations$/.exec(url.pathname);
  if (request.method === "GET" && operationsMatch?.[1]) {
    send(response, 200, runtime.getOperations(operationsMatch[1]));
    return;
  }

  const attemptsMatch = /^\/v1\/runs\/([^/]+)\/attempts$/.exec(url.pathname);
  if (request.method === "GET" && attemptsMatch?.[1]) {
    send(response, 200, runtime.getModelAttempts(attemptsMatch[1]));
    return;
  }

  const contextMatch = /^\/v1\/context-projections\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && contextMatch?.[1]) {
    const context = runtime.getContextProjection(contextMatch[1]);
    send(response, context ? 200 : 404, context ?? { error: "Context projection not found" });
    return;
  }

  const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifactMatch?.[1]) {
    const artifact = runtime.getArtifact(artifactMatch[1]);
    send(response, artifact ? 200 : 404, artifact ?? { error: "Artifact not found" });
    return;
  }

  const artifactContentMatch = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
  if (request.method === "GET" && artifactContentMatch?.[1]) {
    const content = runtime.readArtifact(artifactContentMatch[1]);
    send(response, content === undefined ? 404 : 200,
      content === undefined ? { error: "Artifact not found" } : { content });
    return;
  }

  send(response, 404, { error: "Not found" });
}

function readLimit(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

function optionalParameter(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value.length === 0) throw new RuntimeError("validation", `${name} must not be empty`);
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRunBody(value: unknown): value is { input: string } {
  return typeof value === "object" && value !== null && "input" in value &&
    typeof (value as { input?: unknown }).input === "string";
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

server.listen(port, host, () => {
  process.stdout.write(`CAR daemon listening on http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => {
    runtime.close();
    process.exitCode = 0;
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
