import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage } from "../dist/index.js";

const profile = (provider, model) => ({ id: `${provider}-${model}`, provider, model,
  endpoint: "https://example.test", credentialHandle: "none" });
const capabilities = { version: 1, values: {} };
function attempt(id, runId, provider, model, fields = {}) {
  return { sessionId: fields.sessionId ?? "session-1", attempt: { id, runId,
    operationId: `operation-${id}`, attemptNumber: fields.attemptNumber ?? 1,
    contextProjectionId: `context-${id}`, providerProfile: profile(provider, model), capabilities,
    status: fields.status ?? "completed", startedAt: "start", ...fields,
  } };
}

test("usage aggregation separates requests, retries, outcomes, native coverage, and cost", () => {
  const report = aggregateUsage([
    attempt("a1", "run-1", "openrouter", "model", { normalizedUsage: { version: 1,
      inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.25 } }),
    attempt("a2", "run-1", "openrouter", "model", { attemptNumber: 2, previousAttemptId: "a1",
      retryOfAttemptId: "a1", status: "failed", error: { code: "transport.network" },
      normalizedUsage: { version: 1, inputTokens: 3 } }),
    attempt("a3", "run-2", "google", "gemini", { sessionId: "session-2",
      normalizedUsage: { version: 1, inputTokens: 7, reasoningTokens: 4, totalTokens: 11 } }),
    attempt("a4", "run-2", "google", "gemini", { sessionId: "session-2", attemptNumber: 2,
      previousAttemptId: "a3", usage: { provider_only: true } }),
  ]);
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.totals.runs, 2);
  assert.equal(report.totals.modelRequests, 4);
  assert.equal(report.totals.retries, 1);
  assert.equal(report.totals.outcomes.completed, 3);
  assert.equal(report.totals.outcomes.failed, 1);
  assert.deepEqual(report.totals.errorCodes, { "transport.network": 1 });
  assert.deepEqual(report.totals.tokens, { inputTokens: 20, outputTokens: 2,
    reasoningTokens: 4, totalTokens: 23 });
  assert.equal(report.totals.costUsd, 0.25);
  assert.deepEqual(report.totals.coverage, { normalizedUsage: 3, cost: 1 });
  assert.deepEqual(report.byProviderModel.map((group) => group.key), ["google/gemini", "openrouter/model"]);
  assert.equal(report.byRun.find((group) => group.key === "run-2").retries, 0);
});

test("missing provider cost remains unknown instead of becoming zero", () => {
  const report = aggregateUsage([attempt("a1", "run", "google", "gemini",
    { normalizedUsage: { version: 1, totalTokens: 1 } })]);
  assert.equal(report.totals.costUsd, undefined);
  assert.equal(report.totals.coverage.cost, 0);
});
