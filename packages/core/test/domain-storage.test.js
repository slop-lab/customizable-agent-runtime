import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertOperationTransition,
  KernelDatabase,
  RuntimeError,
  SerializedWriter,
} from "../dist/index.js";

test("operation transitions reject terminal-state changes", () => {
  assert.doesNotThrow(() => assertOperationTransition("pending", "running"));
  assert.throws(
    () => assertOperationTransition("completed", "running"),
    (error) => error instanceof RuntimeError && error.code === "conflict",
  );
});

test("serialized writer preserves command order", async () => {
  const writer = new SerializedWriter();
  const observed = [];
  await Promise.all([
    writer.run(async () => { await Promise.resolve(); observed.push(1); }),
    writer.run(() => { observed.push(2); }),
  ]);
  assert.deepEqual(observed, [1, 2]);
});

test("file database rejects a second active writer and permits it after close", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-storage-"));
  const path = join(directory, "runtime.sqlite");
  const first = new KernelDatabase(path, { owner: "first" });
  assert.throws(
    () => new KernelDatabase(path, { owner: "second" }),
    (error) => error instanceof RuntimeError && error.code === "conflict",
  );
  first.close();
  const second = new KernelDatabase(path, { owner: "second" });
  second.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema migration is transactional", () => {
  const database = new KernelDatabase(":memory:");
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 1);
  assert.throws(() => database.transaction(() => {
    database.db.exec("CREATE TABLE should_rollback(value TEXT)");
    throw new Error("fail migration");
  }));
  assert.equal(
    database.db.prepare("SELECT count(*) count FROM sqlite_master WHERE name = 'should_rollback'").get().count,
    0,
  );
  database.close();
});
