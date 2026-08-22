import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, RuntimeError } from "../dist/index.js";

function tool(name) {
  return { description: { name, version: "1", description: name }, async execute() { return { output: name }; } };
}
function plugin(id, options = {}) {
  return { manifest: { apiVersion: 1, id, version: "1", ...(options.dependencies ? {
    dependencies: options.dependencies,
  } : {}), ...(options.configuration ? { configuration: options.configuration } : {}) },
    async setup(registrar) {
      options.log?.push(`setup:${id}`);
      options.capture?.(registrar);
      for (const name of options.tools ?? []) registrar.registerTool(tool(name));
      if (options.middleware) registrar.registerToolMiddleware(options.middleware);
      if (options.setupError) throw new Error(options.setupError);
    },
    async start() { options.log?.push(`start:${id}`); if (options.startError) throw new Error(options.startError); },
    health: options.health,
    stop() { options.log?.push(`stop:${id}`); if (options.stopError) throw new Error(options.stopError); },
  };
}

test("plugin host orders dependencies deterministically and closes them in reverse", async () => {
  const log = [];
  const configuration = { endpoint: "https://original.test" };
  let captured;
  const host = await PluginHost.initialize([
    plugin("integration.zeta", { dependencies: ["integration.alpha"], log,
      tools: ["integration.zeta.lookup"] }),
    plugin("integration.alpha", { log, configuration, tools: ["integration.alpha.lookup"],
      capture: (value) => { captured = value; } }),
  ]);
  configuration.endpoint = "https://changed.test";
  assert.deepEqual(log, ["setup:integration.alpha", "setup:integration.zeta",
    "start:integration.alpha", "start:integration.zeta"]);
  assert.deepEqual(host.tools().map((value) => value.description.name),
    ["integration.alpha.lookup", "integration.zeta.lookup"]);
  assert.deepEqual(host.identities().map((value) => value.id), ["integration.alpha", "integration.zeta"]);
  assert.equal(host.identities()[0].configuration.endpoint, "https://original.test");
  assert.throws(() => captured.registerTool(tool("integration.alpha.late")),
    (error) => error instanceof RuntimeError && error.code === "conflict");
  assert.deepEqual(host.close(), []);
  assert.deepEqual(log.slice(-2), ["stop:integration.zeta", "stop:integration.alpha"]);
  assert.deepEqual(host.close(), []);
});

test("plugin host rejects invalid graphs and tool namespaces before activation", async () => {
  await assert.rejects(() => PluginHost.initialize([plugin("integration.same"), plugin("integration.same")]),
    /Duplicate plugin/);
  await assert.rejects(() => PluginHost.initialize([
    plugin("integration.child", { dependencies: ["integration.missing"] }),
  ]), /requires missing plugin/);
  await assert.rejects(() => PluginHost.initialize([
    plugin("integration.a", { dependencies: ["integration.b"] }),
    plugin("integration.b", { dependencies: ["integration.a"] }),
  ]), /dependency cycle/);
  await assert.rejects(() => PluginHost.initialize([
    plugin("integration.valid", { tools: ["wrong.lookup"] }),
  ]), /must use namespace/);
});

test("plugin startup fails atomically and cleanup attempts continue after an error", async () => {
  const log = [];
  await assert.rejects(() => PluginHost.initialize([
    plugin("integration.alpha", { log, stopError: "stop failed" }),
    plugin("integration.beta", { dependencies: ["integration.alpha"], log, startError: "start failed" }),
  ]), /Plugin initialization failed: start failed/);
  assert.deepEqual(log.slice(-2), ["stop:integration.beta", "stop:integration.alpha"]);
});

test("plugin health failures and timeouts are inspectable without failing the host", async () => {
  const host = await PluginHost.initialize([
    plugin("integration.failed", { health() { throw new Error("health failed"); } }),
    plugin("integration.slow", { health: () => new Promise(() => {}) }),
  ], { healthTimeoutMs: 20 });
  const inspection = await host.inspect();
  assert.deepEqual(inspection.map((value) => value.health.status), ["failed", "failed"]);
  assert.match(inspection[0].health.message, /health failed/);
  assert.match(inspection[1].health.message, /timed out/);
  host.close();
});
