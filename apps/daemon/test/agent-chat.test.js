import assert from "node:assert/strict";
import test from "node:test";
import { runAgentChat } from "../../../scripts/agent-chat-lib.mjs";

class FakeTerminal {
  closed = false; promptValue = ""; prompts = [];
  constructor(lines) { this.lines = lines; }
  setPrompt(value) { this.promptValue = value; }
  prompt() { this.prompts.push(this.promptValue); }
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
    listSessions() { return [...sessions.values()].map((session) => ({ ...session, updatedAt: session.createdAt,
      recordCount: records.get(session.id).length, runCount: 0,
      runStatusCounts: { running: 0, completed: 0, failed: 0, cancelled: 0 } })); },
    listRuns() { return []; }, getRecords(id) { return records.get(id); },
    async run(sessionId, input) { ran = { sessionId, input }; const values = records.get(sessionId);
      values.push({ kind: "user", data: { text: input } }, { kind: "assistant", data: { text: "done" } });
      return { id: "run", sessionId, status: "completed", startedAt: "now", endedAt: "now" }; },
  };
  const terminal = new FakeTerminal(["/sessions", "/resume old-session", "first", "second", "/send", "/runs", "/id", "/exit"]);
  const output = new FakeOutput();
  await runAgentChat({ runtime, terminal, output, dataDirectory: "/data" });
  assert.deepEqual(ran, { sessionId: "old-session", input: "first\nsecond" });
  assert.match(output.value, /resumed session old-session/); assert.match(output.value, /agent> done/);
  assert.match(output.value, /\nold-session\n/);
});

test("startup resume rejects an unknown session instead of creating an empty one", async () => {
  let created = false;
  const runtime = { getSession() {}, async createSession() { created = true; } };
  await assert.rejects(() => runAgentChat({ runtime, terminal: new FakeTerminal([]), output: new FakeOutput(),
    dataDirectory: "/data", initialSessionId: "missing" }), /Unknown session/);
  assert.equal(created, false);
});
