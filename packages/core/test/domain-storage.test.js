import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("serialized writer rejects nested commands instead of deadlocking", async () => {
  const writer = new SerializedWriter();
  await assert.rejects(
    () => writer.run(() => writer.run(() => "nested")),
    (error) => error instanceof RuntimeError && error.code === "conflict",
  );
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
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
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

test("schema version 2 databases gain normalized provider usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v2-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec("ALTER TABLE model_attempts DROP COLUMN normalized_usage_json; UPDATE schema_metadata SET version = 2");
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  assert.equal(database.db.prepare("PRAGMA table_info(model_attempts)").all()
    .some((column) => column.name === "normalized_usage_json"), true);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema version 3 databases gain immutable run provenance storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v3-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec("DROP TRIGGER run_provenance_immutable; DROP TABLE run_provenance; UPDATE schema_metadata SET version = 3");
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  assert.equal(database.db.prepare("SELECT count(*) count FROM sqlite_master WHERE type = 'table' AND name = 'run_provenance'").get().count, 1);
  assert.equal(database.db.prepare("SELECT count(*) count FROM sqlite_master WHERE type = 'trigger' AND name = 'run_provenance_immutable'").get().count, 1);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema version 4 databases gain artifact ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v4-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec(`ALTER TABLE artifacts DROP COLUMN owner_type;
    ALTER TABLE artifacts DROP COLUMN owner_id;
    ALTER TABLE artifacts DROP COLUMN run_id;
    UPDATE schema_metadata SET version = 4`);
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  const columns = database.db.prepare("PRAGMA table_info(artifacts)").all().map((column) => column.name);
  assert.equal(columns.includes("owner_type"), true);
  assert.equal(columns.includes("owner_id"), true);
  assert.equal(columns.includes("run_id"), true);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema version 5 databases gain immutable worker execution manifests", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v5-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec(`DROP TRIGGER run_worker_execution_manifests_immutable;
    DROP TABLE run_worker_execution_manifests;
    UPDATE schema_metadata SET version = 5`);
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  assert.equal(database.db.prepare(`SELECT count(*) count FROM sqlite_master
    WHERE type = 'table' AND name = 'run_worker_execution_manifests'`).get().count, 1);
  assert.equal(database.db.prepare(`SELECT count(*) count FROM sqlite_master
    WHERE type = 'trigger' AND name = 'run_worker_execution_manifests_immutable'`).get().count, 1);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema version 6 databases gain context transformation audit storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v6-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec("ALTER TABLE context_projections DROP COLUMN transformations_json; UPDATE schema_metadata SET version = 6");
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  assert.equal(database.db.prepare("PRAGMA table_info(context_projections)").all()
    .some((column) => column.name === "transformations_json"), true);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("schema version 7 databases gain immutable adaptive review workflow storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "car-migration-v7-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  database.db.exec(`DROP TRIGGER review_workflow_stage_results_immutable;
    DROP TRIGGER review_workflow_evidence_immutable;
    DROP TRIGGER review_workflow_revisions_immutable;
    DROP TABLE review_workflow_stage_results;
    DROP TABLE review_workflow_evidence;
    DROP TABLE review_workflow_revisions;
    DROP TABLE review_workflows;
    UPDATE schema_metadata SET version = 7`);
  database.close();
  database = new KernelDatabase(path);
  assert.equal(database.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get().version, 8);
  const objects = database.db.prepare(`SELECT name FROM sqlite_master
    WHERE name LIKE 'review_workflow%' ORDER BY name`).all().map((row) => row.name);
  assert.deepEqual(objects, [
    "review_workflow_evidence", "review_workflow_evidence_append_only", "review_workflow_evidence_head",
    "review_workflow_evidence_immutable", "review_workflow_evidence_type", "review_workflow_evidence_workflow", "review_workflow_revisions",
    "review_workflow_revisions_append_only", "review_workflow_revisions_immutable", "review_workflow_stage_results",
    "review_workflow_stage_results_append_only", "review_workflow_stage_results_gate", "review_workflow_stage_results_head",
    "review_workflow_stage_results_immutable", "review_workflow_stage_results_workflow", "review_workflows",
    "review_workflows_identity_immutable", "review_workflows_updated_at",
  ]);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("writer lock is recovered after an ungraceful process exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-crash-lock-"));
  const path = join(directory, "runtime.sqlite");
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist/index.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { KernelDatabase } from ${JSON.stringify(moduleUrl)}; new KernelDatabase(${JSON.stringify(path)}); console.log("ready"); setInterval(() => {}, 1000);`],
    { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`lock holder exited early: ${code}`)));
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const recovered = new KernelDatabase(path);
  recovered.close();
  rmSync(directory, { recursive: true, force: true });
});
