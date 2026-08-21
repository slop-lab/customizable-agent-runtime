import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderFromEnvironment, EnvironmentCredentialResolver, OpenRouterChatProvider, OpenRouterFetchTransport,
} from "../dist/index.js";

function invocation(content = [{ type: "text", role: "user", text: "hello" }]) {
  const requests = []; const events = [];
  return { value: { attemptId: "attempt", context: { id: "context", runId: "run", projectorId: "test",
    projectorVersion: "1", includedRecordIds: [], excludedRecords: [], content, createdAt: "now" },
    tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
    signal: new AbortController().signal, recordRequest: (value) => requests.push(value),
    recordEvent: (type, payload) => events.push({ type, payload }) }, requests, events };
}
function streamOf(...values) { return { async *stream() { yield* values; } }; }
function sse(values) {
  return new Response(`${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(iterable) { const values = []; for await (const value of iterable) values.push(value); return values; }

test("OpenRouter is selected when its key is present and defaults to the verified paid model", () => {
  const provider = createProviderFromEnvironment({ OPENROUTER_API_KEY: "secret" });
  assert.equal(provider.profile.provider, "openrouter");
  assert.equal(provider.profile.model, "google/gemma-4-26b-a4b-it");
});

test("OpenRouter adapter projects text, tool calls, usage, and original message", async () => {
  const chunks = [
    { id: "response", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
      id: "ca", type: "function", function: { name: "re", arguments: "{\"path\":" } }] } }] },
    { id: "response", choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
      id: "ll", function: { name: "ad", arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] },
    { id: "response", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.004,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 1 } } },
  ];
  const transport = streamOf(...chunks);
  const provider = new OpenRouterChatProvider({ model: "google/gemma-test", endpoint: "https://openrouter.test",
    credentialHandle: "env:KEY", transport });
  const trace = invocation(); const turn = await provider.invoke(trace.value);
  assert.equal(trace.requests[0].model, "google/gemma-test");
  assert.deepEqual(turn.content[0], { type: "tool-call", callId: "call", toolName: "read", input: { path: "README.md" } });
  assert.deepEqual(turn.content[1], { type: "provider-native", provider: "openrouter.chat",
    value: { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function",
      function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }] } });
  assert.deepEqual(turn.usage, chunks[2].usage);
  assert.deepEqual(turn.normalizedUsage, { version: 1, inputTokens: 10, outputTokens: 2,
    reasoningTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 12, costUsd: 0.004 });
  assert.equal(trace.events.length, chunks.length);
  assert.deepEqual(trace.events.map((event) => event.type), chunks.map(() => "chat.completion.chunk"));
  assert.equal(trace.requests[0].stream, true);
});

test("OpenRouter stateless projection preserves native assistant and tool result", async () => {
  let body;
  const transport = { async *stream(value) { body = value; yield { id: "response",
    choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] }; } };
  const provider = new OpenRouterChatProvider({ model: "model", endpoint: "endpoint", credentialHandle: "env:KEY", transport });
  const native = { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function",
    function: { name: "read", arguments: "{}" } }] };
  await provider.invoke(invocation([{ type: "text", role: "user", text: "read" },
    { type: "tool-call", callId: "call", toolName: "read", input: {} },
    { type: "provider-native", provider: "openrouter.chat", value: native },
    { type: "tool-result", callId: "call", output: "result", isError: false }]).value);
  assert.deepEqual(body.messages, [{ role: "user", content: "read" }, native,
    { role: "tool", tool_call_id: "call", content: "result" }]);
});

test("OpenRouter adapter assembles text, native reasoning, and parallel indexed tool deltas", async () => {
  const transport = streamOf(
    { id: "response", choices: [{ index: 0, delta: { role: "assistant", content: "hel", reasoning: "think-",
      tool_calls: [{ index: 1, id: "b", function: { name: "shell", arguments: "{\"command\":" } },
        { index: 0, id: "a", function: { name: "read", arguments: "{\"path\":" } }] } }] },
    { id: "response", choices: [{ index: 0, delta: { content: "lo", reasoning: "more",
      tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } },
        { index: 1, function: { arguments: "\"pwd\"}" } }] }, finish_reason: "tool_calls" }] },
  );
  const provider = new OpenRouterChatProvider({ model: "model", endpoint: "endpoint", credentialHandle: "env:KEY", transport });
  const turn = await provider.invoke(invocation().value);
  assert.deepEqual(turn.content.slice(0, 3), [
    { type: "text", role: "assistant", text: "hello" },
    { type: "tool-call", callId: "a", toolName: "read", input: { path: "README.md" } },
    { type: "tool-call", callId: "b", toolName: "shell", input: { command: "pwd" } },
  ]);
  assert.equal(turn.content[3].value.reasoning, "think-more");
});

test("OpenRouter adapter makes malformed streamed tool arguments a permanent failure", async () => {
  const provider = new OpenRouterChatProvider({ model: "model", endpoint: "endpoint", credentialHandle: "env:KEY",
    transport: streamOf({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call",
      function: { name: "read", arguments: "{" } }] }, finish_reason: "tool_calls" }] }) });
  await assert.rejects(() => provider.invoke(invocation().value),
    (error) => error.code === "openrouter.invalid-tool-arguments" && error.retryable === false);
});

test("OpenRouter adapter classifies streamed error envelopes after preserving the chunk", async () => {
  const trace = invocation();
  const provider = new OpenRouterChatProvider({ model: "model", endpoint: "endpoint", credentialHandle: "env:KEY",
    transport: streamOf({ error: { code: 503, message: "upstream unavailable" } }) });
  await assert.rejects(() => provider.invoke(trace.value),
    (error) => error.code === "openrouter.stream.503" && error.retryable === true);
  assert.equal(trace.events.length, 1);
});

test("OpenRouter adapter makes an empty semantic stream retryable", async () => {
  const provider = new OpenRouterChatProvider({ model: "model", endpoint: "endpoint", credentialHandle: "env:KEY",
    transport: streamOf() });
  await assert.rejects(() => provider.invoke(invocation().value),
    (error) => error.code === "openrouter.empty-stream" && error.retryable === true);
});

test("OpenRouter transport keeps credentials internal and does not retry 429", async () => {
  let authorization;
  const credentials = new EnvironmentCredentialResolver({ KEY: "secret" });
  const successful = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async (_url, init) => { authorization = new Headers(init.headers).get("authorization");
      return sse([{ id: "response", choices: [] }]); });
  assert.deepEqual(await collect(successful.stream({}, new AbortController().signal)), [{ id: "response", choices: [] }]);
  assert.equal(authorization, "Bearer secret");

  const limited = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async () => new Response(JSON.stringify({ error: { message: "limited" } }), { status: 429 }));
  await assert.rejects(() => collect(limited.stream({}, new AbortController().signal)),
    (error) => error.code === "openrouter.http.429" && error.retryable === false);
  const unavailable = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }));
  await assert.rejects(() => collect(unavailable.stream({}, new AbortController().signal)), (error) => error.retryable === true);
});
