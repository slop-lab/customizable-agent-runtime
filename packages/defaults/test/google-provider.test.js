import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvironmentCredentialResolver, GoogleFetchInteractionsTransport, GoogleInteractionsProvider, parseSseJson,
} from "../dist/index.js";

function sse(events) {
  return new Response(events.map((value) => `event: ${value.event_type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } });
}
function invocation() {
  const requests = []; const events = [];
  return { value: { attemptId: "attempt", context: { id: "context", runId: "run", projectorId: "test",
    projectorVersion: "1", includedRecordIds: [], excludedRecords: [],
    content: [{ type: "text", role: "user", text: "hello" }], createdAt: "now" },
    tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
    signal: new AbortController().signal, recordRequest: (value) => requests.push(value),
    recordEvent: (type, payload) => events.push({ type, payload }) }, requests, events };
}

test("SSE parser removes framing and preserves semantic JSON payloads", async () => {
  const response = sse([{ event_type: "step.delta", delta: { type: "text", text: "hi" } }]);
  const values = [];
  for await (const value of parseSseJson(response.body, new AbortController().signal)) values.push(value);
  assert.deepEqual(values, [{ event_type: "step.delta", delta: { type: "text", text: "hi" } }]);
});

test("Google adapter projects streamed text while preserving every semantic event", async () => {
  const semanticEvents = [
    { event_type: "step.start", index: 0, step: { type: "model_output", content: [] } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "hello " } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "world" } },
    { event_type: "step.stop", index: 0 },
    { event_type: "interaction.completed", interaction: { id: "response", status: "completed", usage: { total_tokens: 3 } } },
  ];
  const transport = { async *stream() { yield* semanticEvents; } };
  const provider = new GoogleInteractionsProvider({ model: "gemini-test", endpoint: "https://example.test/interactions",
    credentialHandle: "env:KEY", transport });
  const trace = invocation();
  const turn = await provider.invoke(trace.value);
  assert.equal(trace.requests[0].store, false);
  assert.equal(trace.events.length, semanticEvents.length);
  assert.deepEqual(turn.content.slice(0, 1), [{ type: "text", role: "assistant", text: "hello world" }]);
  assert.equal(turn.content[1].type, "provider-native");
  assert.deepEqual(turn.usage, { total_tokens: 3 });
  assert.equal(turn.providerResponseId, "response");
});

test("Google adapter aggregates streamed function arguments", async () => {
  const transport = { async *stream() {
    yield { event_type: "step.start", index: 0, step: { type: "function_call", id: "call", name: "read" } };
    yield { event_type: "step.delta", index: 0, delta: { type: "arguments_delta", arguments: "{\"path\":" } };
    yield { event_type: "step.delta", index: 0, delta: { type: "arguments_delta", arguments: "\"README.md\"}" } };
    yield { event_type: "interaction.completed", interaction: { status: "requires_action" } };
  } };
  const provider = new GoogleInteractionsProvider({ model: "gemini-test", endpoint: "https://example.test",
    credentialHandle: "env:KEY", transport });
  const turn = await provider.invoke(invocation().value);
  assert.deepEqual(turn.content[0], { type: "tool-call", callId: "call", toolName: "read", input: { path: "README.md" } });
  assert.deepEqual(turn.content[1].value,
    { type: "function_call", id: "call", name: "read", arguments: { path: "README.md" } });
});

test("Google adapter reconstructs thought signatures for stateless continuation", async () => {
  const transport = { async *stream() {
    yield { event_type: "step.start", index: 0, step: { type: "thought" } };
    yield { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "signed" } };
    yield { event_type: "interaction.completed", interaction: { status: "completed" } };
  } };
  const provider = new GoogleInteractionsProvider({ model: "gemini-test", endpoint: "https://example.test",
    credentialHandle: "env:KEY", transport });
  const turn = await provider.invoke(invocation().value);
  assert.deepEqual(turn.content, [{ type: "provider-native", provider: "google.interactions",
    value: { type: "thought", signature: "signed" } }]);
});

test("Google stateless projection links function results to their function names", async () => {
  let body;
  const transport = { async *stream(value) {
    body = value;
    yield { event_type: "interaction.completed", interaction: { status: "completed" } };
  } };
  const provider = new GoogleInteractionsProvider({ model: "gemini-test", endpoint: "https://example.test",
    credentialHandle: "env:KEY", transport });
  const trace = invocation();
  trace.value.context.content = [
    { type: "provider-native", provider: "google.interactions",
      value: { type: "function_call", id: "call", name: "read", arguments: { path: "README.md" } } },
    { type: "tool-result", callId: "call", output: "hello", isError: false },
  ];
  await provider.invoke(trace.value);
  assert.deepEqual(body.input[1], { type: "function_result", name: "read", call_id: "call", is_error: false,
    result: [{ type: "text", text: "hello" }] });
});

test("Google transport resolves credentials internally and classifies retryable HTTP errors", async () => {
  let observedHeader;
  const credentials = new EnvironmentCredentialResolver({ KEY: "secret-value" });
  const successful = new GoogleFetchInteractionsTransport("https://example.test", "env:KEY", credentials,
    async (_url, init) => { observedHeader = new Headers(init.headers).get("x-goog-api-key"); return sse([{ event_type: "done" }]); });
  const values = [];
  for await (const value of successful.stream({ input: [] }, new AbortController().signal)) values.push(value);
  assert.equal(observedHeader, "secret-value");
  assert.equal(JSON.stringify(values).includes("secret-value"), false);

  const failing = new GoogleFetchInteractionsTransport("https://example.test", "env:KEY", credentials,
    async () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }));
  await assert.rejects(async () => { for await (const _value of failing.stream({}, new AbortController().signal)) {} },
    (error) => error.retryable === true && error.code === "google.http.503");
});
