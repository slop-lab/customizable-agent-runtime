import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, RuntimeError, ToolDispatcher } from "@car/core";
import { createMcpPlugin, StreamableHttpMcpClient } from "../dist/index.js";

const context = { sessionId: "session", runId: "run", operationId: "operation", workspace: "workspace",
  deadline: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal };

function definition(name, options = {}) {
  return { name, description: options.description ?? name,
    inputSchema: options.inputSchema ?? { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: options.readOnly ?? true } };
}

function fakeClient(options = {}) {
  const calls = []; let closed = 0; let pings = 0;
  return {
    calls,
    get closed() { return closed; },
    get pings() { return pings; },
    async connect(signal, timeoutMs) {
      assert.equal(signal.aborted, false); assert.ok(timeoutMs > 0);
      return { name: "remote", version: "2.1", protocolEra: "legacy" };
    },
    async listTools() { return options.tools ?? [definition("issues.get")]; },
    async callTool(tool, input, signal, timeoutMs) {
      calls.push({ tool: tool.name, input, signal, timeoutMs });
      if (options.call) return options.call(tool, input, signal, timeoutMs);
      return { content: [{ type: "text", text: "done" }] };
    },
    async ping() { pings++; },
    async close() { closed++; },
  };
}

test("MCP plugin exposes only allowlisted read-only tools with deterministic names and bounded projections", async () => {
  const client = fakeClient({ tools: [definition("search/repositories", { description: "Search repositories" }),
    definition("Issues.Get"), definition("write.issue", { readOnly: false })],
  call: async (tool) => tool.name === "Issues.Get"
    ? { content: [{ type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "resource_link", name: "issue", uri: "https://remote.test/issues/1" }], isError: true }
    : { content: [{ type: "text", text: "found" }], structuredContent: { ignored: true } } });
  const host = await PluginHost.initialize([createMcpPlugin({ serverId: "work", endpoint: "https://mcp.test/rpc",
    credentialHandle: "env:MCP_TOKEN", allowedTools: ["search/repositories", "Issues.Get"], client })]);
  const tools = host.tools();
  assert.deepEqual(tools.map((tool) => tool.description.name),
    ["integration.mcp.work.issues-get", "integration.mcp.work.search-repositories"]);
  assert.equal(tools[0].description.inputSchema.type, "object");
  const dispatcher = new ToolDispatcher(tools);
  const issue = await dispatcher.dispatch("integration.mcp.work.issues-get", { index: 1 }, context);
  assert.equal(issue.isError, true);
  assert.match(issue.output, /image omitted/);
  assert.match(issue.output, /https:\/\/remote\.test\/issues\/1/);
  assert.equal((await dispatcher.dispatch("integration.mcp.work.search-repositories", { q: "car" }, context)).output,
    "found");
  assert.deepEqual(client.calls.map(({ tool, input, timeoutMs }) => ({ tool, input, timeoutMs })), [
    { tool: "Issues.Get", input: { index: 1 }, timeoutMs: 30_000 },
    { tool: "search/repositories", input: { q: "car" }, timeoutMs: 30_000 },
  ]);
  assert.deepEqual(host.identities(), [{ id: "integration.mcp.work", version: "1", dependencies: [],
    configuration: { allowedTools: ["Issues.Get", "search/repositories"], credentialHandle: "env:MCP_TOKEN",
      endpoint: "https://mcp.test/rpc", requireReadOnly: true,
      limits: { callTimeoutMs: 30_000, connectionTimeoutMs: 10_000, maximumListPages: 8, maximumResultBytes: 65_536,
        maximumSchemaBytes: 65_536, maximumTools: 32 } } }]);
  assert.deepEqual((await host.inspect())[0].health,
    { status: "ready", message: "Connected to remote@2.1" });
  assert.equal(client.pings, 1);
  assert.deepEqual(await host.close(), []);
  assert.equal(client.closed, 1);
});

test("MCP plugin rejects unlisted, mutating, colliding, and oversized catalogs and closes failed clients", async () => {
  const cases = [
    { tools: [definition("listed")], allowedTools: ["missing"], message: /not listed/ },
    { tools: [definition("write", { readOnly: false })], allowedTools: ["write"], message: /not declared read-only/ },
    { tools: [definition("read.issue"), definition("read_issue")], allowedTools: ["read.issue", "read_issue"],
      message: /collision/ },
    { tools: [definition("huge", { inputSchema: { type: "object", description: "x".repeat(1_000) } })],
      allowedTools: ["huge"], maximumSchemaBytes: 20, message: /schemas exceeded/ },
  ];
  for (const item of cases) {
    const client = fakeClient({ tools: item.tools });
    await assert.rejects(() => PluginHost.initialize([createMcpPlugin({ serverId: "policy",
      endpoint: "https://mcp.test", allowedTools: item.allowedTools, client,
      ...(item.maximumSchemaBytes ? { maximumSchemaBytes: item.maximumSchemaBytes } : {}) })]), item.message);
    assert.equal(client.closed, 1);
  }
});

test("MCP plugin enforces object input, result bounds, and cancellation", async () => {
  const oversized = fakeClient({ call: async () => ({ content: [{ type: "text", text: "x".repeat(100) }] }) });
  const oversizedHost = await PluginHost.initialize([createMcpPlugin({ serverId: "bounded",
    endpoint: "https://mcp.test", allowedTools: ["issues.get"], maximumResultBytes: 20, client: oversized })]);
  const dispatcher = new ToolDispatcher(oversizedHost.tools());
  await assert.rejects(() => dispatcher.dispatch("integration.mcp.bounded.issues-get", [], context),
    (error) => error.code === "validation");
  await assert.rejects(() => dispatcher.dispatch("integration.mcp.bounded.issues-get", {}, context),
    (error) => error instanceof RuntimeError && error.code === "internal" && /exceeded/.test(error.message));
  await oversizedHost.close();

  const cancelled = fakeClient({ call: async (_tool, _input, signal) => {
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const cancelledHost = await PluginHost.initialize([createMcpPlugin({ serverId: "cancelled",
    endpoint: "https://mcp.test", allowedTools: ["issues.get"], client: cancelled })]);
  const cancelledDispatcher = new ToolDispatcher(cancelledHost.tools());
  const controller = new AbortController();
  const pending = cancelledDispatcher.dispatch("integration.mcp.cancelled.issues-get", {}, { ...context,
    signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === "cancelled");
  await cancelledHost.close();
});

test("Streamable HTTP adapter negotiates a legacy MCP server and resolves bearer credentials per request", async () => {
  const requests = []; let resolutions = 0;
  const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.test/rpc", credentialHandle: "env:TOKEN",
    credentials: { resolve(handle) { resolutions++; assert.equal(handle, "env:TOKEN"); return `secret-${resolutions}`; } },
    fetchImplementation: async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? JSON.parse(await request.text()) : undefined;
      requests.push({ method: request.method, rpcMethod: body?.method,
        authorization: request.headers.get("authorization") });
      if (request.method === "GET") return new Response("", { status: 405 });
      if (request.method === "DELETE") return new Response("", { status: 200 });
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "server/discover") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          error: { code: -32601, message: "Method not found" } }), { status: 200,
          headers: { "content-type": "application/json" } });
      }
      let result;
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      else if (body.method === "tools/list") result = { tools: [definition("issues.get")] };
      else if (body.method === "tools/call") result = { content: [{ type: "text", text: body.params.arguments.value }] };
      else if (body.method === "ping") result = {};
      else throw new Error(`Unexpected method: ${body.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200,
        headers: { "content-type": "application/json" } });
    } });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.connect(signal, 1_000), { name: "fixture", version: "1", protocolEra: "legacy" });
  const [tool] = await client.listTools(signal, 1_000);
  assert.equal(tool.name, "issues.get");
  assert.deepEqual(await client.callTool(tool, { value: "ok" }, signal, 1_000),
    { content: [{ type: "text", text: "ok" }] });
  await client.ping(signal, 1_000);
  await client.close();
  assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.rpcMethod),
    ["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
  assert.ok(requests.every((request, index) => request.authorization === `Bearer secret-${index + 1}`));
  assert.equal(resolutions, requests.length);
});

test("Streamable HTTP adapter rejects endpoints and credential configuration that could disclose secrets", () => {
  assert.throws(() => new StreamableHttpMcpClient({ endpoint: "https://token@mcp.test/rpc" }), /without credentials/);
  assert.throws(() => new StreamableHttpMcpClient({ endpoint: "https://mcp.test/rpc?token=x" }), /query/);
  assert.throws(() => new StreamableHttpMcpClient({ endpoint: "https://mcp.test", credentialHandle: "env:TOKEN" }),
    /resolver is required/);
});
