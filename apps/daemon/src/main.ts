#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultRuntime,
  createContextTransformsFromEnvironment,
  createProviderFromEnvironment,
  createRuntimeProvenanceFromEnvironment,
  EnvironmentCredentialResolver,
} from "@car/defaults";
import {
  PluginHost,
  RuntimeError,
  type CompleteReviewStageInput,
  type CreateReviewWorkflowInput,
  type ReviewEvidenceInput,
  type RuntimePlugin,
} from "@car/core";
import { createGiteaPlugin, GiteaFetchTransport } from "@car/plugin-gitea";
import { createStreamableHttpMcpPlugin } from "@car/plugin-mcp";
import { webUiHtml } from "./web-ui.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const environmentFile = join(repositoryRoot, ".env");
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const dataDirectory = process.env.CAR_DATA_DIR ?? join(repositoryRoot, ".car");
mkdirSync(dataDirectory, { recursive: true });
const workerBackend = readWorkerBackend(process.env.CAR_WORKER_BACKEND);
const provider = createProviderFromEnvironment();
const contextTransforms = createContextTransformsFromEnvironment();
const provenance = createRuntimeProvenanceFromEnvironment();
const pluginHost = await PluginHost.initialize(createPluginsFromEnvironment());
let runtime: ReturnType<typeof createDefaultRuntime>;
try {
  runtime = createDefaultRuntime({ databasePath: join(dataDirectory, "runtime.sqlite"),
    artifactRoot: join(dataDirectory, "artifacts"), workspaceRoot: repositoryRoot,
    workerBackend, provider, provenance, pluginHost, contextTransforms });
} catch (error) {
  await pluginHost.close();
  throw error;
}
const host = process.env.CAR_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CAR_PORT ?? "4317", 10);
const allowedOrigins = readAllowedOrigins(host, port, process.env.CAR_ALLOWED_ORIGINS);
const allowedHosts = new Set([...allowedOrigins].map((origin) => new URL(origin).host.toLowerCase()));

function readWorkerBackend(value: string | undefined): "local" | "isolated-process" {
  if (value === undefined || value === "local") return "local";
  if (value === "isolated-process") return value;
  throw new RuntimeError("validation", `Unknown worker backend: ${value}`);
}

function createPluginsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly RuntimePlugin[] {
  const selected = (environment.CAR_PLUGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return selected.map((name) => {
    if (name === "gitea") {
      const baseUrl = requiredEnvironment(environment, "CAR_GITEA_URL");
      const credentialHandle = environment.CAR_GITEA_CREDENTIAL_HANDLE ?? "env:DIM_GIT_TOKEN";
      const transport = new GiteaFetchTransport(baseUrl, credentialHandle,
        new EnvironmentCredentialResolver(environment));
      return createGiteaPlugin({ baseUrl, credentialHandle, transport });
    }
    if (name === "mcp") {
      const credentialHandle = optionalEnvironment(environment, "CAR_MCP_CREDENTIAL_HANDLE");
      return createStreamableHttpMcpPlugin({
        serverId: environment.CAR_MCP_SERVER_ID ?? "remote",
        endpoint: requiredEnvironment(environment, "CAR_MCP_URL"),
        allowedTools: commaSeparatedEnvironment(environment, "CAR_MCP_ALLOWED_TOOLS"),
        ...(credentialHandle === undefined ? {} : {
          credentialHandle,
          credentials: new EnvironmentCredentialResolver(environment),
        }),
        ...optionalInteger(environment, "CAR_MCP_CONNECT_TIMEOUT_MS", "connectionTimeoutMs"),
        ...optionalInteger(environment, "CAR_MCP_CALL_TIMEOUT_MS", "callTimeoutMs"),
        ...optionalInteger(environment, "CAR_MCP_MAX_LIST_PAGES", "maximumListPages"),
        ...optionalInteger(environment, "CAR_MCP_MAX_TOOLS", "maximumTools"),
        ...optionalInteger(environment, "CAR_MCP_MAX_SCHEMA_BYTES", "maximumSchemaBytes"),
        ...optionalInteger(environment, "CAR_MCP_MAX_RESULT_BYTES", "maximumResultBytes"),
      });
    }
    throw new RuntimeError("validation", `Unknown plugin: ${name}`);
  });
}

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (!value) throw new RuntimeError("validation", `Required environment variable is not set: ${name}`);
  return value;
}

function optionalEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new RuntimeError("validation", `${name} must not be empty`);
  return value;
}

function commaSeparatedEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return requiredEnvironment(environment, name).split(",").map((value) => value.trim()).filter(Boolean);
}

function optionalInteger(environment: Readonly<Record<string, string | undefined>>, name: string, key: string) {
  const value = environment[name];
  if (value === undefined) return {};
  if (!/^\d+$/.test(value)) throw new RuntimeError("validation", `${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RuntimeError("validation", `${name} must be a positive integer`);
  }
  return { [key]: parsed };
}

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
  assertAllowedRequest(request, allowedOrigins, allowedHosts);
  if (request.method === "POST") requireJsonContentType(request);
  const url = new URL(request.url ?? "/", `http://${request.headers.host!}`);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    sendHtml(response, webUiHtml);
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    send(response, 200, runtime.capabilities());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/plugins") {
    send(response, 200, await pluginHost.inspect());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/usage") {
    const sessionId = optionalParameter(url, "sessionId");
    const runId = optionalParameter(url, "runId");
    send(response, 200, runtime.usage({ ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/review-workflows") {
    const body = await readJson(request);
    if (!isObject(body)) throw new RuntimeError("validation", "Review workflow body must be a JSON object");
    send(response, 201, await runtime.createReviewWorkflow(body as unknown as CreateReviewWorkflowInput));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/review-workflows") {
    const limit = readLimit(url);
    if (limit === undefined) { send(response, 400, { error: "limit must be an integer from 1 through 100" }); return; }
    send(response, 200, runtime.listReviewWorkflows({ limit }));
    return;
  }

  const reviewHistoryMatch = /^\/v1\/review-workflows\/([^/]+)\/history$/.exec(url.pathname);
  if (request.method === "GET" && reviewHistoryMatch?.[1]) {
    const limit = readLimit(url);
    if (limit === undefined) { send(response, 400, { error: "limit must be an integer from 1 through 100" }); return; }
    send(response, 200, runtime.getReviewWorkflowHistory(pathParameter(reviewHistoryMatch[1], "workflow id"), {
      limit, ...readBeforeRevision(url),
    }));
    return;
  }

  const reviewWorkflowMatch = /^\/v1\/review-workflows\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && reviewWorkflowMatch?.[1]) {
    const workflow = runtime.getReviewWorkflow(pathParameter(reviewWorkflowMatch[1], "workflow id"));
    send(response, workflow ? 200 : 404, workflow ?? { error: "Review workflow not found" });
    return;
  }

  const reviewEvidenceMatch = /^\/v1\/review-workflows\/([^/]+)\/evidence$/.exec(url.pathname);
  if (request.method === "POST" && reviewEvidenceMatch?.[1]) {
    const body = await readJson(request);
    if (!isObject(body) || !isObject(body.evidence)) {
      throw new RuntimeError("validation", "Expected expectedRevision and evidence object");
    }
    send(response, 200, await runtime.appendReviewEvidence(pathParameter(reviewEvidenceMatch[1], "workflow id"),
      readExpectedRevision(body.expectedRevision), body.evidence as unknown as ReviewEvidenceInput));
    return;
  }

  const reviewStageMatch = /^\/v1\/review-workflows\/([^/]+)\/stages\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && reviewStageMatch?.[1] && reviewStageMatch[2]) {
    const body = await readJson(request);
    if (!isObject(body) || !isObject(body.evidence)) {
      throw new RuntimeError("validation", "Expected expectedRevision and evidence object");
    }
    const input: CompleteReviewStageInput = { expectedRevision: readExpectedRevision(body.expectedRevision),
      stageId: pathParameter(reviewStageMatch[2], "stage id"), evidence: body.evidence as unknown as ReviewEvidenceInput };
    send(response, 200, await runtime.completeReviewStage(pathParameter(reviewStageMatch[1], "workflow id"), input));
    return;
  }

  const reviewHeadMatch = /^\/v1\/review-workflows\/([^/]+)\/head$/.exec(url.pathname);
  if (request.method === "POST" && reviewHeadMatch?.[1]) {
    const body = await readJson(request);
    if (!isObject(body) || typeof body.headSha !== "string" || typeof body.externalEventId !== "string" ||
      !isObject(body.source)) {
      throw new RuntimeError("validation", "Expected expectedRevision, headSha, externalEventId, and source");
    }
    send(response, 200, await runtime.updateReviewWorkflowHead(pathParameter(reviewHeadMatch[1], "workflow id"), {
      expectedRevision: readExpectedRevision(body.expectedRevision), headSha: body.headSha,
      externalEventId: body.externalEventId,
      source: body.source as unknown as ReviewEvidenceInput["source"],
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    await readJsonObject(request, "Session creation body");
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
    const execution = await runtime.startRun(runsMatch[1], body.input);
    void execution.completion.catch((error) => {
      process.stderr.write(`CAR background run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    send(response, 202, execution.run);
    return;
  }

  const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelMatch?.[1]) {
    await readJsonObject(request, "Run cancellation body");
    send(response, runtime.cancelRun(cancelMatch[1]) ? 202 : 404, {});
    return;
  }

  const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && runMatch?.[1]) {
    const run = runtime.getRun(runMatch[1]);
    send(response, run ? 200 : 404, run ?? { error: "Run not found" });
    return;
  }

  const provenanceMatch = /^\/v1\/runs\/([^/]+)\/provenance$/.exec(url.pathname);
  if (request.method === "GET" && provenanceMatch?.[1]) {
    const provenance = runtime.getRunProvenance(provenanceMatch[1]);
    send(response, provenance ? 200 : 404, provenance ?? { error: "Run provenance not found" });
    return;
  }

  const workerManifestsMatch = /^\/v1\/runs\/([^/]+)\/worker-execution-manifests$/.exec(url.pathname);
  if (request.method === "GET" && workerManifestsMatch?.[1]) {
    if (!runtime.getRun(workerManifestsMatch[1])) { send(response, 404, { error: "Run not found" }); return; }
    send(response, 200, runtime.getRunWorkerExecutionManifests(workerManifestsMatch[1]));
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
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength <= 128 * 1024) chunks.push(buffer);
    else tooLarge = true;
  }
  if (tooLarge) throw new RuntimeError("validation", "Request body must not exceed 128 KiB");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new RuntimeError("validation", "Request body must be valid JSON"); }
}

async function readJsonObject(request: IncomingMessage, label: string): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (!isObject(value)) throw new RuntimeError("validation", `${label} must be a JSON object`);
  return value;
}

function readAllowedOrigins(host: string, port: number, configured: string | undefined): ReadonlySet<string> {
  const values = new Set<string>();
  if (isLoopbackHost(host)) {
    values.add(`http://127.0.0.1:${port}`);
    values.add(`http://localhost:${port}`);
    values.add(`http://[::1]:${port}`);
  }
  for (const candidate of (configured ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { throw new RuntimeError("validation", `Invalid CAR_ALLOWED_ORIGINS origin: ${candidate}`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== candidate ||
      parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new RuntimeError("validation", `CAR_ALLOWED_ORIGINS must contain exact HTTP origins: ${candidate}`);
    }
    values.add(parsed.origin);
  }
  if (values.size === 0) {
    throw new RuntimeError("validation", "CAR_ALLOWED_ORIGINS is required when CAR_HOST is not loopback");
  }
  return values;
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function assertAllowedRequest(request: IncomingMessage, origins: ReadonlySet<string>, hosts: ReadonlySet<string>): void {
  const requestHost = request.headers.host?.toLowerCase();
  if (!requestHost || !hosts.has(requestHost)) {
    throw new RuntimeError("validation", "Request Host is not allowed");
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.has(origin)) {
    throw new RuntimeError("validation", "Request Origin is not allowed");
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RuntimeError("validation", "POST requests require Content-Type: application/json");
  }
}

function pathParameter(value: string, label: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new RuntimeError("validation", `Malformed percent-encoding in ${label}`); }
}

function readBeforeRevision(url: URL): { readonly beforeRevision?: number } {
  const value = url.searchParams.get("beforeRevision");
  if (value === null) return {};
  if (!/^\d+$/.test(value)) throw new RuntimeError("validation", "beforeRevision must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RuntimeError("validation", "beforeRevision must be a positive integer");
  }
  return { beforeRevision: parsed };
}

function isRunBody(value: unknown): value is { input: string } {
  return typeof value === "object" && value !== null && "input" in value &&
    typeof (value as { input?: unknown }).input === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RuntimeError("validation", "expectedRevision must be a positive integer");
  }
  return Number(value);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(response: ServerResponse, body: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  response.end(body);
}

server.listen(port, host, () => {
  process.stdout.write(`CAR daemon listening on http://${host}:${port}\n`);
});

function shutdown() {
  server.close(async () => {
    try { await runtime.close(); process.exitCode = 0; }
    catch (error) {
      process.stderr.write(`CAR daemon cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
