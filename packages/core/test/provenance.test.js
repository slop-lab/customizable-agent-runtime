import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, createRunProvenance, defaultTraceRedactor, hashCanonicalJson } from "../dist/index.js";

test("canonical provenance hashing is independent of object key order", () => {
  assert.equal(canonicalJson({ z: 1, nested: { b: 2, a: 1 } }),
    '{"nested":{"a":1,"b":2},"z":1}');
  assert.equal(hashCanonicalJson({ b: 2, a: 1 }), hashCanonicalJson({ a: 1, b: 2 }));
});

test("run provenance is redacted, versioned, and hashes canonical tool schemas", () => {
  const stored = createRunProvenance({
    runId: "run-1",
    createdAt: "2026-08-22T00:00:00.000Z",
    environment: {
      runtime: { id: "@car/core", version: "0.0.0", sourceRevision: "abc123" },
      workspace: { id: "workspace-1", token: "must-not-survive" },
      worker: { id: "worker", version: "1", configuration: { secret: "must-not-survive" } },
      security: { profile: "local-development",
        redactionPolicy: { id: "core.trace.default", version: "1" } },
    },
    workspaceHandle: "opaque-workspace",
    driver: { id: "driver", version: "1", configuration: { maximumAttempts: 12 } },
    provider: {
      id: "provider",
      version: "1",
      profile: { id: "profile", provider: "fake", model: "model", endpoint: "fake://local",
        credentialHandle: "opaque-handle" },
      capabilities: { version: 1, values: {} },
      transport: { id: "transport", version: "1" },
    },
    contextProjector: { id: "projector", version: "1" },
    tools: [
      { name: "z-tool", version: "1", description: "z", inputSchema: { required: ["value"], type: "object" } },
      { name: "a-tool", version: "2", description: "a", inputSchema: { type: "object", required: ["value"] } },
    ],
    redact: (value) => defaultTraceRedactor.redact(value),
  });

  assert.equal(stored.manifest.version, 1);
  assert.equal(stored.manifest.runtime.sourceRevision, "abc123");
  assert.deepEqual(stored.manifest.tools.map((tool) => tool.id), ["a-tool", "z-tool"]);
  assert.equal(stored.manifest.tools[0].inputSchemaHash, stored.manifest.tools[1].inputSchemaHash);
  assert.equal(stored.manifest.workspace.identity.token, "[redacted]");
  assert.equal(stored.manifest.worker.configuration.secret, "[redacted]");
  assert.equal(stored.manifestHash, hashCanonicalJson(stored.manifest));
});
