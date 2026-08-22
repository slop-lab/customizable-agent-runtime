import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { RuntimeError } from "./errors.js";

const schema = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  );
  INSERT INTO schema_metadata(singleton, version) VALUES (1, 1)
    ON CONFLICT(singleton) DO NOTHING;

  CREATE TABLE IF NOT EXISTS writer_lock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS run_provenance (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS run_provenance_immutable
    BEFORE UPDATE ON run_provenance
    BEGIN
      SELECT RAISE(ABORT, 'run provenance is immutable');
    END;
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error TEXT,
    result_json TEXT
  );
  CREATE TABLE IF NOT EXISTS records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS command_receipts (
    idempotency_key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    committed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    media_type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    status TEXT NOT NULL,
    byte_length INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,
    created_at TEXT NOT NULL,
    finalized_at TEXT
  );
  CREATE TABLE IF NOT EXISTS context_projections (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    projector_id TEXT NOT NULL,
    projector_version TEXT NOT NULL,
    included_record_ids_json TEXT NOT NULL,
    excluded_records_json TEXT NOT NULL,
    content_json TEXT NOT NULL,
    request_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    operation_id TEXT NOT NULL REFERENCES operations(id),
    attempt_number INTEGER NOT NULL,
    previous_attempt_id TEXT REFERENCES model_attempts(id),
    retry_of_attempt_id TEXT REFERENCES model_attempts(id),
    context_projection_id TEXT NOT NULL REFERENCES context_projections(id),
    request_artifact_id TEXT REFERENCES artifacts(id),
    event_artifact_id TEXT REFERENCES artifacts(id),
    provider_profile_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    finish_reason TEXT,
    usage_json TEXT,
    normalized_usage_json TEXT,
    provider_response_id TEXT,
    error_json TEXT,
    retry_decision_json TEXT,
    UNIQUE(run_id, attempt_number)
  );

  UPDATE schema_metadata SET version = 2 WHERE singleton = 1 AND version < 2;
`;

export class SerializedWriter {
  #tail: Promise<void> = Promise.resolve();
  readonly #context = new AsyncLocalStorage<boolean>();

  run<T>(command: () => T | Promise<T>): Promise<T> {
    if (this.#context.getStore()) {
      return Promise.reject(new RuntimeError("conflict", "Nested writer commands are not allowed"));
    }
    const execute = async () => {
      return this.#context.run(true, command);
    };
    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface KernelDatabaseOptions {
  readonly owner?: string;
  readonly acquireWriterLock?: boolean;
}

export class KernelDatabase {
  readonly db: DatabaseSync;
  readonly writer = new SerializedWriter();
  readonly #owner: string;
  readonly #hasWriterLock: boolean;
  readonly #lockPath: string | undefined;
  #lockFd: number | undefined;
  #closed = false;

  constructor(path: string, options: KernelDatabaseOptions = {}) {
    this.#owner = options.owner ?? randomUUID();
    this.#hasWriterLock = options.acquireWriterLock ?? path !== ":memory:";
    this.#lockPath = this.#hasWriterLock ? `${path}.writer.lock` : undefined;
    if (this.#hasWriterLock) this.acquireWriterLock();
    try {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
      if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.migrate();
    } catch (error) {
      this.releaseWriterLock();
      throw error;
    }
  }

  migrate(): void {
    this.transaction(() => {
      this.db.exec(schema);
      const version = Number((this.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get() as
        { version: number }).version);
      if (version < 3) {
        const columns = this.db.prepare("PRAGMA table_info(model_attempts)").all() as { name: string }[];
        if (!columns.some((column) => column.name === "normalized_usage_json")) {
          this.db.exec("ALTER TABLE model_attempts ADD COLUMN normalized_usage_json TEXT");
        }
        this.db.prepare("UPDATE schema_metadata SET version = 3 WHERE singleton = 1").run();
      }
      const currentVersion = Number((this.db.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get() as
        { version: number }).version);
      if (currentVersion < 4) {
        this.db.prepare("UPDATE schema_metadata SET version = 4 WHERE singleton = 1").run();
      }
    });
  }

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.db.close();
    this.releaseWriterLock();
    this.#closed = true;
  }

  private acquireWriterLock(): void {
    const path = this.#lockPath!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ owner: this.#owner, pid: process.pid }));
        this.#lockFd = fd;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readLock(path);
        if (existing && isProcessAlive(existing.pid)) {
          throw new RuntimeError("conflict", "The database already has an active writer", { pid: existing.pid });
        }
        try { unlinkSync(path); } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new RuntimeError("conflict", "Could not acquire the database writer lock");
  }

  private releaseWriterLock(): void {
    if (this.#lockFd !== undefined) { closeSync(this.#lockFd); this.#lockFd = undefined; }
    if (!this.#lockPath) return;
    const existing = readLock(this.#lockPath);
    if (existing?.owner !== this.#owner) return;
    try { unlinkSync(this.#lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface LockData { readonly owner: string; readonly pid: number }
function readLock(path: string): LockData | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockData>;
    return typeof value.owner === "string" && typeof value.pid === "number"
      ? { owner: value.owner, pid: value.pid } : undefined;
  } catch { return undefined; }
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
