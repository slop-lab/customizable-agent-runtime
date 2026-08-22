import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactIngressStore } from "@car/core";
import { createDefaultRuntime, LocalDevelopmentWorker } from "../dist/index.js";

test("large worker output is projected and promoted to an operation-owned artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-artifact-ingress-"));
  const workspaceRoot = join(directory, "workspace");
  const artifactRoot = join(directory, "artifacts");
  const ingressRoot = join(directory, "ingress");
  mkdirSync(workspaceRoot);
  execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
  const fullOutput = Array.from({ length: 80 }, (_, index) => `line ${index}: ${"x".repeat(20)}`).join("\n");
  writeFileSync(join(workspaceRoot, "large.txt"), fullOutput);

  const ingress = new ArtifactIngressStore(ingressRoot, 4_096);
  const worker = new LocalDevelopmentWorker({ workspace: "workspace", root: workspaceRoot,
    maxOutputBytes: 128, maxArtifactBytes: 4_096, artifactIngress: ingress });
  const contexts = [];
  let invocation = 0;
  const provider = { id: "artifact-provider", profile: { id: "artifact", provider: "fake", model: "artifact",
    endpoint: "fake://artifact", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.tools.calls": { supported: true } } }, async invoke(request) {
      contexts.push(request.context.content);
      request.recordRequest({ input: request.context.content });
      invocation++;
      const turn = invocation === 1
        ? { content: [{ type: "tool-call", callId: "call-1", toolName: "read", input: { path: "large.txt" } }] }
        : { content: [{ type: "text", role: "assistant", text: "done" }], finishReason: "completed" };
      request.recordEvent("interaction.completed", turn);
      return turn;
    } };
  const runtime = createDefaultRuntime({ provider, worker, workspace: "workspace", workspaceRoot,
    databasePath: join(directory, "runtime.sqlite"), artifactRoot, artifactIngressRoot: ingressRoot });

  try {
    const session = await runtime.createSession("session");
    const run = await runtime.run(session.id, "Read the large file");
    assert.equal(run.status, "completed");
    const projected = contexts[1].find((content) => content.type === "tool-result");
    assert.ok(projected);
    assert.ok(Buffer.byteLength(projected.output) < Buffer.byteLength(fullOutput));
    assert.match(projected.output, /full output: artifact:\/\//);
    assert.equal(projected.artifacts.length, 1);

    const [reference] = projected.artifacts;
    const metadata = runtime.getArtifact(reference.id);
    const toolOperation = runtime.getOperations(run.id).find((operation) => operation.kind === "tool");
    assert.deepEqual(metadata.ownership, { type: "operation", id: toolOperation.id, runId: run.id });
    assert.equal(metadata.sha256, reference.sha256);
    assert.equal(metadata.byteLength, Buffer.byteLength(fullOutput));
    assert.equal(runtime.readArtifact(reference.id), fullOutput);
    const record = runtime.getRecords(session.id).find((entry) => entry.kind === "tool-result");
    assert.deepEqual(record.data.artifacts, [reference]);
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
