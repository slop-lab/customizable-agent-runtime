#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRuntime, createProviderFromEnvironment,
  createRuntimeProvenanceFromEnvironment } from "../packages/defaults/dist/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const directory = mkdtempSync(join(tmpdir(), "car-google-live-"));
const provider = createProviderFromEnvironment({ ...process.env, CAR_PROVIDER: "google-ai-studio" });
const runtime = createDefaultRuntime({ provider, databasePath: join(directory, "runtime.sqlite"),
  artifactRoot: join(directory, "artifacts"), workspaceRoot: process.cwd(),
  provenance: createRuntimeProvenanceFromEnvironment() });

try {
  const session = await runtime.createSession("google-live-smoke");
  const run = await runtime.run(session.id,
    "You must use the read tool to read package.json. Then reply with only the workspace package name from its name field.");
  const attempts = runtime.getModelAttempts(run.id);
  const records = runtime.getRecords(session.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(attempts.length, 2, `Expected two model attempts, got ${attempts.length}`);
  assert.equal(attempts.every((attempt) => attempt.status === "completed"), true);
  assert.equal(records.some((record) => record.kind === "tool-call"), true);
  assert.equal(records.some((record) => record.kind === "tool-result"), true);
  assert.equal(records.findLast((record) => record.kind === "assistant")?.data.text, "@car/workspace");
  process.stdout.write(`${JSON.stringify({ runId: run.id, status: run.status,
    attempts: attempts.length, answer: "@car/workspace" })}\n`);
} finally {
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
}
