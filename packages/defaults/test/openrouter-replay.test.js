import assert from "node:assert/strict";
import test from "node:test";
import { FakeWorker } from "@car/core";
import {
  createDefaultRuntime, DemoAgentDriver, EnvironmentCredentialResolver, OpenRouterChatProvider,
  OpenRouterFetchTransport,
} from "../dist/index.js";
import { assertFixtureHasNoSecrets, openRouterFixture, replayFetch } from "./openrouter-fixtures.js";

function providerWithReplay(replay) {
  const endpoint = "https://openrouter.fixture/chat/completions"; const credentialHandle = "env:FIXTURE_KEY";
  return new OpenRouterChatProvider({ model: "fixture-model", endpoint, credentialHandle,
    transport: new OpenRouterFetchTransport(endpoint, credentialHandle,
      new EnvironmentCredentialResolver({ FIXTURE_KEY: "local-test-value" }), replay.fetch) });
}
function invocation() {
  const requests = []; const events = [];
  return { request: { attemptId: "attempt", context: { id: "context", runId: "run", projectorId: "test",
    projectorVersion: "1", includedRecordIds: [], excludedRecords: [],
    content: [{ type: "text", role: "user", text: "hello" }], createdAt: "now" },
    tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
    signal: new AbortController().signal, recordRequest: (value) => requests.push(value),
    recordEvent: (type, payload) => events.push({ type, payload }) }, requests, events };
}

test("redacted OpenRouter text fixture replays through fetch, SSE, and the real adapter", async () => {
  const fixture = await openRouterFixture("text-success"); const replay = replayFetch(fixture);
  const trace = invocation(); const turn = await providerWithReplay(replay).invoke(trace.request);
  assert.equal(turn.content[0].text, "fixture answer");
  assert.equal(turn.normalizedUsage.totalTokens, 5); assert.equal(trace.events.length, 3);
  replay.assertConsumed();
});

test("OpenRouter tool-loop fixture drives the durable runtime and preserves every chunk", async () => {
  const fixture = await openRouterFixture("tool-loop"); const replay = replayFetch(fixture);
  const worker = new FakeWorker((request) => request.type === "readFile"
    ? { ok: true, output: "fixture file" } : { ok: false, code: "worker-failed", message: "unexpected" });
  const runtime = createDefaultRuntime({ provider: providerWithReplay(replay), worker,
    driver: new DemoAgentDriver({ sleep: async () => {} }) });
  const session = await runtime.createSession("fixture-session");
  const run = await runtime.run(session.id, "read fixture");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind),
    ["user", "tool-call", "provider-native", "tool-result", "assistant", "provider-native"]);
  const attempts = runtime.getModelAttempts(run.id); assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => runtime.readArtifact(attempt.eventArtifactId).trim().split("\n").length), [2, 2]);
  replay.assertConsumed(); runtime.close();
});

test("OpenRouter replay keeps 5xx retryable and 429 terminal", async () => {
  const retryFixture = await openRouterFixture("retry-5xx"); const retryReplay = replayFetch(retryFixture);
  let runtime = createDefaultRuntime({ provider: providerWithReplay(retryReplay),
    driver: new DemoAgentDriver({ maximumRetries: 1, sleep: async () => {} }) });
  let session = await runtime.createSession("retry-session"); let run = await runtime.run(session.id, "retry");
  assert.equal(run.status, "completed");
  assert.deepEqual(runtime.getModelAttempts(run.id).map((attempt) => attempt.status), ["failed", "completed"]);
  assert.equal(runtime.getModelAttempts(run.id)[1].retryOfAttemptId, runtime.getModelAttempts(run.id)[0].id);
  retryReplay.assertConsumed(); runtime.close();

  const limitedFixture = await openRouterFixture("terminal-429"); const limitedReplay = replayFetch(limitedFixture);
  runtime = createDefaultRuntime({ provider: providerWithReplay(limitedReplay),
    driver: new DemoAgentDriver({ maximumRetries: 3, sleep: async () => {} }) });
  session = await runtime.createSession("limited-session"); run = await runtime.run(session.id, "limited");
  assert.equal(run.status, "failed"); assert.equal(runtime.getModelAttempts(run.id).length, 1);
  assert.equal(runtime.getModelAttempts(run.id)[0].error.code, "openrouter.http.429");
  limitedReplay.assertConsumed(); runtime.close();
});

test("OpenRouter malformed arguments and cancellation replay as inspectable terminal attempts", async () => {
  const malformedFixture = await openRouterFixture("malformed-tool"); const malformedReplay = replayFetch(malformedFixture);
  let runtime = createDefaultRuntime({ provider: providerWithReplay(malformedReplay) });
  let session = await runtime.createSession("malformed-session"); let run = await runtime.run(session.id, "malformed");
  assert.equal(run.status, "failed");
  assert.equal(runtime.getModelAttempts(run.id)[0].error.code, "openrouter.invalid-tool-arguments");
  malformedReplay.assertConsumed(); runtime.close();

  const cancellationFixture = await openRouterFixture("cancellation"); const cancellationReplay = replayFetch(cancellationFixture);
  runtime = createDefaultRuntime({ provider: providerWithReplay(cancellationReplay) });
  session = await runtime.createSession("cancel-session"); const execution = await runtime.startRun(session.id, "cancel");
  while (cancellationReplay.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
  execution.cancel(); run = await execution.completion;
  assert.equal(run.status, "cancelled"); assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user"]);
  assert.equal(runtime.getModelAttempts(run.id)[0].status, "cancelled");
  cancellationReplay.assertConsumed(); runtime.close();
});

test("committed OpenRouter fixtures contain no credential-shaped values", async () => {
  for (const name of ["text-success", "tool-loop", "retry-5xx", "terminal-429", "malformed-tool", "cancellation"]) {
    const fixture = await openRouterFixture(name);
    assert.doesNotThrow(() => assertFixtureHasNoSecrets(fixture));
  }
});
