import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore, KernelDatabase, RuntimeRepository } from "../dist/index.js";

test("provider semantic events are appended and finalized as a hashed artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-artifacts-"));
  const store = new ArtifactStore(directory);
  const writer = store.create("events-1", "provider-events", "application/x-ndjson", "start");
  writer.appendJsonLine({ sequence: 1, eventType: "step.delta", payload: { text: "hello" } });
  const metadata = writer.finalize("completed", "end");
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.sha256.length, 64);
  assert.match(readFileSync(join(directory, metadata.relativePath), "utf8"), /step\.delta/);
  rmSync(directory, { recursive: true, force: true });
});

test("attempts retain context, artifacts, profile, usage, and retry decisions", () => {
  const database = new KernelDatabase(":memory:");
  const repository = new RuntimeRepository(database);
  database.transaction(() => {
    database.db.prepare("INSERT INTO sessions(id, created_at) VALUES ('session', 'start')").run();
    database.db.prepare("INSERT INTO runs(id, session_id, status, started_at) VALUES ('run', 'session', 'running', 'start')").run();
    database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at) VALUES ('operation', 'run', 'model', 'running', 'start')").run();
  });
  repository.saveContextProjection({ id: "context", runId: "run", projectorId: "test", projectorVersion: "1",
    includedRecordIds: [], excludedRecords: [], content: [{ type: "text", text: "hello" }], createdAt: "start" });
  const profile = { id: "profile", provider: "fake", model: "fake", endpoint: "fake://local", credentialHandle: "none" };
  const capabilities = { version: 1, values: { "core.streaming.text": { supported: true } } };
  repository.createModelAttempt({ id: "attempt", runId: "run", operationId: "operation", attemptNumber: 1,
    contextProjectionId: "context", providerProfile: profile, capabilities, status: "running", startedAt: "start" });
  repository.finishModelAttempt("attempt", "failed", { endedAt: "end", error: { code: "temporary" },
    retryDecision: { retry: true, reason: "temporary" }, usage: { totalTokens: 3 } });
  const [attempt] = repository.listModelAttempts("run");
  assert.equal(attempt.status, "failed");
  assert.deepEqual(attempt.error, { code: "temporary" });
  assert.deepEqual(attempt.retryDecision, { retry: true, reason: "temporary" });
  assert.deepEqual(attempt.usage, { totalTokens: 3 });
  database.close();
});
