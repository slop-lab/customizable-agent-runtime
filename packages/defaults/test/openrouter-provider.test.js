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

test("OpenRouter is selected when its key is present and defaults to the verified paid model", () => {
  const provider = createProviderFromEnvironment({ OPENROUTER_API_KEY: "secret" });
  assert.equal(provider.profile.provider, "openrouter");
  assert.equal(provider.profile.model, "google/gemma-4-26b-a4b-it");
});

test("OpenRouter adapter projects text, tool calls, usage, and original message", async () => {
  const response = { id: "response", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const transport = { async send() { return response; } };
  const provider = new OpenRouterChatProvider({ model: "google/gemma-test", endpoint: "https://openrouter.test",
    credentialHandle: "env:KEY", transport });
  const trace = invocation(); const turn = await provider.invoke(trace.value);
  assert.equal(trace.requests[0].model, "google/gemma-test");
  assert.deepEqual(turn.content[0], { type: "tool-call", callId: "call", toolName: "read", input: { path: "README.md" } });
  assert.deepEqual(turn.content[1], { type: "provider-native", provider: "openrouter.chat",
    value: response.choices[0].message });
  assert.deepEqual(turn.usage, response.usage);
  assert.equal(trace.events[0].payload, response);
});

test("OpenRouter stateless projection preserves native assistant and tool result", async () => {
  let body;
  const transport = { async send(value) { body = value; return { choices: [{ message: { role: "assistant", content: "done" } }] }; } };
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

test("OpenRouter transport keeps credentials internal and does not retry 429", async () => {
  let authorization;
  const credentials = new EnvironmentCredentialResolver({ KEY: "secret" });
  const successful = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async (_url, init) => { authorization = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [] }), { status: 200 }); });
  assert.deepEqual(await successful.send({}, new AbortController().signal), { choices: [] });
  assert.equal(authorization, "Bearer secret");

  const limited = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async () => new Response(JSON.stringify({ error: { message: "limited" } }), { status: 429 }));
  await assert.rejects(() => limited.send({}, new AbortController().signal),
    (error) => error.code === "openrouter.http.429" && error.retryable === false);
  const unavailable = new OpenRouterFetchTransport("https://openrouter.test", "env:KEY", credentials,
    async () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }));
  await assert.rejects(() => unavailable.send({}, new AbortController().signal), (error) => error.retryable === true);
});
