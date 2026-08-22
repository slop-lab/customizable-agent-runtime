import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerExecutionManifest, hashCanonicalJson } from "../dist/index.js";

test("worker execution manifests contain only projected environment keys and hash deterministically", () => {
  const stored = createWorkerExecutionManifest({ version: 1, worker: { id: "worker", version: "1" },
    leaseId: "lease", startedAt: "now", runtime: { name: "node", version: "24", platform: "linux",
      architecture: "x64" }, workspace: { handle: "workspace" }, environment: { keys: ["PATH", "LANG"] },
    isolation: { kind: "process", filesystem: "workspace-scoped", environment: "explicit-projection" },
    resourceLimits: { maximumInlineOutputBytes: 1024, maximumArtifactBytes: 4096 },
    requestTypes: ["shell", "readFile"] });
  assert.deepEqual(stored.manifest.environment.keys, ["LANG", "PATH"]);
  assert.deepEqual(stored.manifest.requestTypes, ["readFile", "shell"]);
  assert.equal(stored.manifestHash, hashCanonicalJson(stored.manifest));
  assert.equal(JSON.stringify(stored).includes("secret-value"), false);
});
