import type { Operation, OperationStatus } from "./domain.js";
import { assertOperationTransition } from "./domain.js";
import { RuntimeError } from "./errors.js";
import type { RecordEntry, RecordKind, Run, RuntimeEvent, Session } from "./contracts.js";
import type { KernelDatabase } from "./storage.js";

type Row = Readonly<Record<string, unknown>>;
export interface PendingEvent extends RuntimeEvent { readonly sequence: number }

export class RuntimeRepository {
  constructor(readonly database: KernelDatabase) {}

  command<T>(idempotencyKey: string, now: string, action: () => T): T {
    return this.database.transaction(() => {
      const receipt = this.database.db.prepare("SELECT result_json FROM command_receipts WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | undefined;
      if (receipt) return JSON.parse(String(receipt.result_json)) as T;
      const result = action();
      this.database.db.prepare("INSERT INTO command_receipts(idempotency_key, result_json, committed_at) VALUES (?, ?, ?)")
        .run(idempotencyKey, JSON.stringify(result), now);
      return result;
    });
  }

  createSession(session: Session, event: RuntimeEvent): void {
    this.database.db.prepare("INSERT INTO sessions(id, created_at) VALUES (?, ?)").run(session.id, session.createdAt);
    this.appendEvent(event);
  }

  getSession(id: string): Session | undefined {
    const row = this.database.db.prepare("SELECT id, created_at FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? { id: String(row.id), createdAt: String(row.created_at) } : undefined;
  }

  createRun(run: Run, operation: Operation, userRecord: RecordEntry, events: readonly RuntimeEvent[]): void {
    this.database.db.prepare("INSERT INTO runs(id, session_id, status, started_at) VALUES (?, ?, ?, ?)")
      .run(run.id, run.sessionId, run.status, run.startedAt);
    this.database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(operation.id, operation.runId, operation.kind, operation.status, operation.startedAt ?? null);
    this.insertRecord(userRecord);
    for (const event of events) this.appendEvent(event);
  }

  getRun(id: string): Run | undefined {
    const row = this.database.db.prepare("SELECT id, session_id, status, started_at, ended_at, error FROM runs WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  getOperation(id: string): Operation | undefined {
    const row = this.database.db.prepare("SELECT id, run_id, kind, status, started_at, ended_at, error, result_json FROM operations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  listOperations(runId: string): readonly Operation[] {
    return (this.database.db.prepare("SELECT id, run_id, kind, status, started_at, ended_at, error, result_json FROM operations WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Row[]).map(operationFromRow);
  }

  createOperation(operation: Operation, event: RuntimeEvent): void {
    this.database.transaction(() => {
      this.database.db.prepare("INSERT INTO operations(id, run_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?)")
        .run(operation.id, operation.runId, operation.kind, operation.status, operation.startedAt ?? null);
      this.appendEvent(event);
    });
  }

  finishOperation(id: string, status: OperationStatus, now: string, event: RuntimeEvent,
    result?: unknown, error?: string): Operation {
    return this.database.transaction(() => {
      const operation = this.transitionOperation(id, status, now, result, error);
      this.appendEvent(event);
      return operation;
    });
  }

  appendRecord(record: RecordEntry, event: RuntimeEvent): void {
    this.database.transaction(() => { this.insertRecord(record); this.appendEvent(event); });
  }

  getRecords(sessionId: string): readonly RecordEntry[] {
    return (this.database.db.prepare("SELECT id, session_id, run_id, kind, data_json, created_at FROM records WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as Row[]).map((row) => ({
        id: String(row.id), sessionId: String(row.session_id), runId: String(row.run_id),
        kind: String(row.kind) as RecordKind, data: JSON.parse(String(row.data_json)) as unknown,
        createdAt: String(row.created_at),
      }));
  }

  transitionOperation(id: string, status: OperationStatus, now: string, result?: unknown, error?: string): Operation {
    const current = this.getOperation(id);
    if (!current) throw new RuntimeError("not-found", `Unknown operation: ${id}`);
    assertOperationTransition(current.status, status);
    this.database.db.prepare("UPDATE operations SET status = ?, ended_at = ?, result_json = ?, error = ? WHERE id = ?")
      .run(status, isTerminal(status) ? now : null, result === undefined ? null : JSON.stringify(result), error ?? null, id);
    return this.getOperation(id)!;
  }

  finishRun(runId: string, operationId: string, status: Run["status"], now: string, event: RuntimeEvent, error?: string): Run {
    return this.database.transaction(() => {
      this.transitionOperation(operationId, status === "completed" ? "completed" : status, now, undefined, error);
      this.database.db.prepare("UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?")
        .run(status, now, error ?? null, runId);
      this.appendEvent(event);
      return this.getRun(runId)!;
    });
  }

  recoverAbandoned(now: string, eventFactory: (operation: Operation) => RuntimeEvent): number {
    return this.database.transaction(() => {
      const rows = this.database.db.prepare("SELECT id, run_id, kind, status, started_at, ended_at, error, result_json FROM operations WHERE status IN ('pending', 'running')")
        .all() as Row[];
      for (const row of rows) {
        const operation = operationFromRow(row);
        this.transitionOperation(operation.id, "abandoned", now, undefined, "abandoned after daemon restart");
        if (operation.kind === "run") {
          this.database.db.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ? AND status = 'running'")
            .run(now, "abandoned after daemon restart", operation.runId);
        }
        this.appendEvent(eventFactory(operation));
      }
      return rows.length;
    });
  }

  pendingEvents(): readonly PendingEvent[] {
    return (this.database.db.prepare("SELECT sequence, event_id, type, occurred_at, data_json FROM outbox WHERE published_at IS NULL ORDER BY sequence")
      .all() as Row[]).map((row) => ({ sequence: Number(row.sequence), id: String(row.event_id),
        type: String(row.type) as RuntimeEvent["type"], occurredAt: String(row.occurred_at),
        data: JSON.parse(String(row.data_json)) as unknown }));
  }

  markPublished(sequence: number, now: string): void {
    this.database.db.prepare("UPDATE outbox SET published_at = ? WHERE sequence = ? AND published_at IS NULL").run(now, sequence);
  }

  private insertRecord(record: RecordEntry): void {
    this.database.db.prepare("INSERT INTO records(id, session_id, run_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.sessionId, record.runId, record.kind, JSON.stringify(record.data), record.createdAt);
  }

  private appendEvent(event: RuntimeEvent): void {
    this.database.db.prepare("INSERT INTO outbox(event_id, type, occurred_at, data_json) VALUES (?, ?, ?, ?)")
      .run(event.id, event.type, event.occurredAt, JSON.stringify(event.data));
  }
}

function isTerminal(status: OperationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "abandoned";
}
function runFromRow(row: Row): Run {
  return { id: String(row.id), sessionId: String(row.session_id), status: String(row.status) as Run["status"],
    startedAt: String(row.started_at), ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    ...(row.error === null ? {} : { error: String(row.error) }) };
}
function operationFromRow(row: Row): Operation {
  return { id: String(row.id), runId: String(row.run_id), kind: String(row.kind) as Operation["kind"],
    status: String(row.status) as OperationStatus,
    ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
    ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    ...(row.error === null ? {} : { error: String(row.error) }),
    ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) as unknown }) };
}
