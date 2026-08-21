import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KernelDatabase, Runtime, RuntimeRepository, ToolDispatcher } from "../dist/index.js";

const provider = {
  id: "fake",
  capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, cancellation: true },
  async *stream() { yield { content: { type: "text", text: "persisted" } }; },
};

test("sessions, terminal runs, records, and operations survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-runtime-"));
  const path = join(directory, "runtime.sqlite");
  let runtime = new Runtime(provider, new ToolDispatcher([]), { database: new KernelDatabase(path) });
  const session = await runtime.createSession("stable-command");
  const duplicate = await runtime.createSession("stable-command");
  assert.deepEqual(duplicate, session);
  const run = await runtime.run(session.id, "hello");
  assert.equal(run.status, "completed");
  runtime.close();

  runtime = new Runtime(provider, new ToolDispatcher([]), { database: new KernelDatabase(path) });
  assert.deepEqual(runtime.getSession(session.id), session);
  assert.equal(runtime.getRun(run.id).status, "completed");
  assert.deepEqual(runtime.getRecords(session.id).map((record) => record.kind), ["user", "assistant"]);
  assert.deepEqual(runtime.getOperations(run.id).map((operation) => operation.status), ["completed"]);
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
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
  let runtime = new Runtime(provider, new ToolDispatcher([]), { database: new KernelDatabase(path) });
  const session = await runtime.createSession("event-command");
  runtime.close();

  runtime = new Runtime(provider, new ToolDispatcher([]), { database: new KernelDatabase(path) });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  assert.equal(events.filter((event) => event.type === "session.created").length, 1);
  assert.equal(events.find((event) => event.type === "session.created").data.id, session.id);
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

test("outbox retains the same event for retry when publication fails", async () => {
  const runtime = new Runtime(provider, new ToolDispatcher([]));
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
    database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at, ended_at) VALUES ('done', 'run', 'tool', 'completed', 'start', 'end')").run();
  });
  database.close();

  const runtime = new Runtime(provider, new ToolDispatcher([]), { database: new KernelDatabase(path) });
  assert.equal(runtime.getOperations("run").find((operation) => operation.id === "running").status, "abandoned");
  assert.equal(runtime.getOperations("run").find((operation) => operation.id === "done").status, "completed");
  assert.equal(runtime.getRun("run").status, "failed");
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});
