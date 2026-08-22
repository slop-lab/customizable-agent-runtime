import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactIngressStore, ArtifactStore } from "../dist/index.js";

test("artifact ingress verifies ownership, size, and hash before durable promotion", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-artifact-ingress-"));
  const ingress = new ArtifactIngressStore(join(directory, "ingress"), 1024);
  const artifacts = new ArtifactStore(join(directory, "artifacts"));
  const descriptor = ingress.stageText("operation-1", "complete tool output");
  assert.throws(() => artifacts.ingest("wrong-owner", descriptor, ingress,
    { type: "operation", id: "operation-2", runId: "run-1" }, "now"), /ownership mismatch/);

  const metadata = artifacts.ingest("artifact-1", descriptor, ingress,
    { type: "operation", id: "operation-1", runId: "run-1" }, "now");
  assert.equal(metadata.kind, "tool-output");
  assert.equal(metadata.ownership.id, "operation-1");
  assert.equal(metadata.byteLength, Buffer.byteLength("complete tool output"));
  assert.equal(readFileSync(join(directory, "artifacts", metadata.relativePath), "utf8"), "complete tool output");
  rmSync(directory, { recursive: true, force: true });
});

test("artifact ingress rejects changed staging content", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-artifact-tamper-"));
  const ingress = new ArtifactIngressStore(join(directory, "ingress"), 1024);
  const artifacts = new ArtifactStore(join(directory, "artifacts"));
  const descriptor = ingress.stageText("operation-1", "original");
  writeFileSync(join(directory, "ingress", `${descriptor.ingressId}.ingress`), "tampered");
  assert.throws(() => artifacts.ingest("artifact-1", descriptor, ingress,
    { type: "operation", id: "operation-1", runId: "run-1" }, "now"), /size mismatch|hash mismatch/);
  rmSync(directory, { recursive: true, force: true });
});

test("artifact ingress refuses symlink substitution", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-artifact-symlink-"));
  const ingress = new ArtifactIngressStore(join(directory, "ingress"), 1024);
  const artifacts = new ArtifactStore(join(directory, "artifacts"));
  const descriptor = ingress.stageText("operation-1", "outside");
  const outside = join(directory, "outside");
  writeFileSync(outside, "outside");
  const staged = join(directory, "ingress", `${descriptor.ingressId}.ingress`);
  unlinkSync(staged);
  symlinkSync(outside, staged);
  assert.throws(() => artifacts.ingest("artifact-1", descriptor, ingress,
    { type: "operation", id: "operation-1", runId: "run-1" }, "now"));
  rmSync(directory, { recursive: true, force: true });
});
