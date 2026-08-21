import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
`;

export class SerializedWriter {
  #tail: Promise<void> = Promise.resolve();
  #active = false;

  run<T>(command: () => T | Promise<T>): Promise<T> {
    const execute = async () => {
      if (this.#active) {
        throw new RuntimeError("conflict", "Nested writer commands are not allowed");
      }
      this.#active = true;
      try {
        return await command();
      } finally {
        this.#active = false;
      }
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
  #closed = false;

  constructor(path: string, options: KernelDatabaseOptions = {}) {
    this.#owner = options.owner ?? randomUUID();
    this.#hasWriterLock = options.acquireWriterLock ?? path !== ":memory:";
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    if (this.#hasWriterLock) this.acquireWriterLock();
  }

  migrate(): void {
    this.transaction(() => this.db.exec(schema));
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
    if (this.#hasWriterLock) {
      this.db.prepare("DELETE FROM writer_lock WHERE singleton = 1 AND owner = ?").run(this.#owner);
    }
    this.db.close();
    this.#closed = true;
  }

  private acquireWriterLock(): void {
    try {
      this.db.prepare("INSERT INTO writer_lock(singleton, owner) VALUES (1, ?)").run(this.#owner);
    } catch (error) {
      this.db.close();
      throw new RuntimeError("conflict", "The database already has an active writer", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
