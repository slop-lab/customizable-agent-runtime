import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runAgentChat } from "../../../scripts/agent-chat-lib.mjs";

class FakeTerminal extends EventEmitter {
  closed = false; promptValue = ""; prompts = [];
  constructor(lines) { super(); this.lines = lines; }
  setPrompt(value) { this.promptValue = value; }
  prompt() { this.prompts.push(this.promptValue); }
  close() { this.closed = true; }
  async *[Symbol.asyncIterator]() { yield* this.lines; }
}
class FakeOutput { value = ""; write(value) { this.value += value; } }

test("interactive chat lists and resumes durable sessions without losing multiline input", async () => {
  const sessions = new Map([["old-session", { id: "old-session", createdAt: "2026-08-20T00:00:00.000Z" }]]);
  const records = new Map([["old-session", []]]); let created = 0; let ran;
  const runtime = {
    async createSession() { const value = { id: `new-session-${++created}`, createdAt: "2026-08-21T00:00:00.000Z" };
      sessions.set(value.id, value); records.set(value.id, []); return value; },
    getSession(id) { return sessions.get(id); },
    usage() { return { totals: { runs: 1, modelRequests: 2, retries: 1, tokens: { totalTokens: 12 },
      costUsd: 0.01, coverage: { normalizedUsage: 2, cost: 1, tokens: { totalTokens: 2 } },
      outcomes: { running: 0, completed: 1, failed: 1, cancelled: 0, abandoned: 0 } } }; },
    listSessions() { return [...sessions.values()].map((session) => ({ ...session, updatedAt: session.createdAt,
      recordCount: records.get(session.id).length, runCount: 0,
      runStatusCounts: { running: 0, completed: 0, failed: 0, cancelled: 0 } })); },
    listRuns() { return []; }, getRecords(id) { return records.get(id); }, getModelAttempts() { return []; },
    async startRun(sessionId, input) { ran = { sessionId, input }; const values = records.get(sessionId);
      values.push({ kind: "user", data: { text: input } }, { kind: "assistant", data: { text: "done" } });
      const run = { id: "run", sessionId, status: "completed", startedAt: "now", endedAt: "now" };
      return { run: { ...run, status: "running" }, completion: Promise.resolve(run), cancel() { return true; } }; },
  };
  const terminal = new FakeTerminal(["/sessions", "/resume old-session", "/usage", "first", "second", "/send", "/runs", "/id", "/exit"]);
  const output = new FakeOutput();
  await runAgentChat({ runtime, terminal, output, dataDirectory: "/data" });
  assert.deepEqual(ran, { sessionId: "old-session", input: "first\nsecond" });
  assert.match(output.value, /resumed session old-session/); assert.match(output.value, /agent> done/);
  assert.match(output.value, /usage: runs=1 model-requests=2 retries=1 tokens=12 cost=\$0\.010000/);
  assert.match(output.value, /\nold-session\n/);
});

test("Ctrl-C cancels the active run and reports attempts separately from retries", async () => {
  const terminal = new FakeTerminal(["cancel this", "/send", "/exit"]); const output = new FakeOutput();
  const records = []; let cancelCalled = false; let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  const runtime = {
    async createSession() { return { id: "session", createdAt: "now" }; }, getRecords() { return records; },
    async startRun(sessionId, input) {
      records.push({ kind: "user", data: { text: input } });
      setImmediate(() => terminal.emit("SIGINT"));
      return { run: { id: "active", sessionId, status: "running", startedAt: "now" }, completion,
        cancel() { cancelCalled = true; finish({ id: "active", sessionId, status: "cancelled", startedAt: "now", endedAt: "end" }); return true; } };
    },
    getModelAttempts() { return [{ id: "a1" }, { id: "a2", retryOfAttemptId: "a1" }]; },
  };
  await runAgentChat({ runtime, terminal, output, dataDirectory: "/data" });
  assert.equal(cancelCalled, true); assert.match(output.value, /cancelling run active/);
  assert.match(output.value, /model requests=2; retries=1/);
});

test("startup resume rejects an unknown session instead of creating an empty one", async () => {
  let created = false;
  const runtime = { getSession() {}, async createSession() { created = true; } };
  await assert.rejects(() => runAgentChat({ runtime, terminal: new FakeTerminal([]), output: new FakeOutput(),
    dataDirectory: "/data", initialSessionId: "missing" }), /Unknown session/);
  assert.equal(created, false);
});
