import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KernelDatabase, Runtime, RuntimeRepository, ToolDispatcher } from "../dist/index.js";
import { appendOneTurnDriver, providerFrom } from "./agent-fixtures.js";

const provider = providerFrom(async () => ({ content: [{ type: "text", role: "assistant", text: "persisted" }] }));
const tools = new ToolDispatcher([]);

test("sessions, terminal runs, records, and operations survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-runtime-"));
  const path = join(directory, "runtime.sqlite");
  let runtime = new Runtime(provider, appendOneTurnDriver, tools, { database: new KernelDatabase(path) });
  const session = await runtime.createSession("stable-command");
  const duplicate = await runtime.createSession("stable-command");
  assert.deepEqual(duplicate, session);
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  runtime.close();

  runtime = new Runtime(provider, appendOneTurnDriver, tools, { database: new KernelDatabase(path) });
  assert.deepEqual(runtime.getSession(session.id), session);
  assert.equal(runtime.getRun(run.id).status, "completed");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "assistant"]);
  assert.deepEqual(runtime.getOperations(run.id).map((operation) => operation.status), ["completed", "completed"]);
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

test("session and run summaries are durable, bounded, and distinguish retries from continuation", async () => {
  const system = (() => { let id = 0; let tick = 0; return {
    ids: { next: () => `summary-${++id}` },
    clock: { now: () => `2026-08-21T00:00:${String(tick++).padStart(2, "0")}.000Z` },
  }; })();
  let invocation = 0;
  const summaryProvider = providerFrom(async () => {
    invocation++;
    if (invocation === 1) return { content: [{ type: "tool-call", callId: "call", toolName: "effect", input: {} }] };
    return { content: [{ type: "text", role: "assistant", text: "done" }] };
  });
  const loopingDriver = { id: "test.summary", version: "1", async run(context) {
    const first = await context.invokeModel();
    for (const content of first.content) await context.append(content);
    await context.dispatch(first.content[0]);
    const second = await context.invokeModel();
    for (const content of second.content) await context.append(content);
  } };
  const tool = { description: { name: "effect", description: "effect" }, async execute() { return { output: "ok" }; } };
  const runtime = new Runtime(summaryProvider, loopingDriver, new ToolDispatcher([tool]), { system });
  const empty = await runtime.createSession("empty");
  const session = await runtime.createSession("summary");
  const run = await runtime.run(session.id, "first line\nsecond line");

  const sessions = runtime.listSessions();
  assert.deepEqual(sessions.map((value) => value.id), [session.id, empty.id]);
  assert.equal(sessions[0].firstUserMessage, "first line");
  assert.equal(sessions[0].recordCount, 4);
  assert.equal(sessions[0].runStatusCounts.completed, 1);
  const [summary] = runtime.listRuns(session.id);
  assert.equal(summary.id, run.id);
  assert.equal(summary.modelRequestCount, 2);
  assert.equal(summary.retryCount, 0);
  assert.equal(summary.toolOperationCount, 1);
  assert.deepEqual(summary.providerModels, [{ provider: "fake", model: "fake" }]);
  assert.equal(runtime.listSessions({ limit: 1 }).length, 1);
  assert.throws(() => runtime.listSessions({ limit: 0 }), /Limit must be/);
  assert.throws(() => runtime.listRuns("missing"), /Unknown session/);
  runtime.close();
});

test("a command failure rolls back materialized state and its receipt", () => {
  const database = new KernelDatabase(":memory:");
  const repository = new RuntimeRepository(database);
  assert.throws(() => repository.command("failed-command", "now", () => {
    database.db.prepare("INSERT INTO sessions(id, created_at) VALUES ('partial', 'now')").run();
    throw new Error("before commit");
  }));
  assert.equal(database.db.prepare("SELECT count(*) count FROM sessions").get().count, 0);
  assert.equal(database.db.prepare("SELECT count(*) count FROM command_receipts").get().count, 0);
  database.close();
});

test("committed outbox events publish after a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-outbox-"));
  const path = join(directory, "runtime.sqlite");
  let runtime = new Runtime(provider, appendOneTurnDriver, tools, { database: new KernelDatabase(path) });
  const session = await runtime.createSession("event-command");
  runtime.close();

  runtime = new Runtime(provider, appendOneTurnDriver, tools, { database: new KernelDatabase(path) });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  assert.equal(events.filter((event) => event.type === "session.created").length, 1);
  assert.equal(events.find((event) => event.type === "session.created").data.id, session.id);
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

test("outbox retains the same event for retry when publication fails", async () => {
  const runtime = new Runtime(provider, appendOneTurnDriver, tools);
  const session = await runtime.createSession("retry-event");
  let failedId;
  assert.throws(() => runtime.subscribe((event) => { failedId = event.id; throw new Error("consumer failed"); }));
  const retried = [];
  runtime.subscribe((event) => retried.push(event));
  assert.equal(retried.find((event) => event.type === "session.created").id, failedId);
  assert.equal(retried.find((event) => event.type === "session.created").data.id, session.id);
  runtime.close();
});

test("startup abandons stale running operations without changing terminal operations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-recovery-"));
  const path = join(directory, "runtime.sqlite");
  const database = new KernelDatabase(path);
  database.transaction(() => {
    database.db.prepare("INSERT INTO sessions(id, created_at) VALUES ('session', 'start')").run();
    database.db.prepare("INSERT INTO runs(id, session_id, status, started_at) VALUES ('run', 'session', 'running', 'start')").run();
    database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at) VALUES ('running', 'run', 'run', 'running', 'start')").run();
    database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at) VALUES ('model', 'run', 'model', 'running', 'start')").run();
    database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at, ended_at) VALUES ('done', 'run', 'tool', 'completed', 'start', 'end')").run();
    database.db.prepare(`INSERT INTO context_projections
      (id, run_id, projector_id, projector_version, included_record_ids_json, excluded_records_json, content_json, created_at)
      VALUES ('context', 'run', 'test', '1', '[]', '[]', '[]', 'start')`).run();
    database.db.prepare(`INSERT INTO model_attempts
      (id, run_id, operation_id, attempt_number, context_projection_id, provider_profile_json, capabilities_json, status, started_at)
      VALUES ('attempt', 'run', 'model', 1, 'context', '{}', '{"version":1,"values":{}}', 'running', 'start')`).run();
  });
  database.close();

  const runtime = new Runtime(provider, appendOneTurnDriver, tools, { database: new KernelDatabase(path) });
  assert.equal(runtime.getOperations("run").find((operation) => operation.id === "running").status, "abandoned");
  assert.equal(runtime.getOperations("run").find((operation) => operation.id === "done").status, "completed");
  assert.equal(runtime.getModelAttempts("run")[0].status, "abandoned");
  assert.equal(runtime.getRun("run").status, "failed");
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});
