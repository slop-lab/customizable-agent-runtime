import type { Operation, OperationStatus } from "./domain.js";
import { assertOperationTransition } from "./domain.js";
import { RuntimeError } from "./errors.js";
import type { RecordEntry, RecordKind, Run, RuntimeEvent, Session } from "./contracts.js";
import type { KernelDatabase } from "./storage.js";
import type { ArtifactMetadata } from "./artifacts.js";
import type { ContextProjection, ModelAttempt, ModelAttemptStatus } from "./agent-contracts.js";

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

  saveArtifact(artifact: ArtifactMetadata): void {
    this.database.db.prepare(`INSERT INTO artifacts(
      id, kind, media_type, relative_path, status, byte_length, sha256, created_at, finalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, byte_length=excluded.byte_length,
      sha256=excluded.sha256, finalized_at=excluded.finalized_at`)
      .run(artifact.id, artifact.kind, artifact.mediaType, artifact.relativePath, artifact.status,
        artifact.byteLength, artifact.sha256 ?? null, artifact.createdAt, artifact.finalizedAt ?? null);
  }

  getArtifact(id: string): ArtifactMetadata | undefined {
    const row = this.database.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  saveContextProjection(value: ContextProjection): void {
    this.database.db.prepare(`INSERT INTO context_projections(
      id, run_id, projector_id, projector_version, included_record_ids_json,
      excluded_records_json, content_json, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.runId, value.projectorId, value.projectorVersion,
        JSON.stringify(value.includedRecordIds), JSON.stringify(value.excludedRecords), JSON.stringify(value.content),
        value.requestHash ?? null, value.createdAt);
  }

  getContextProjection(id: string): ContextProjection | undefined {
    const row = this.database.db.prepare("SELECT * FROM context_projections WHERE id = ?").get(id) as Row | undefined;
    return row ? contextFromRow(row) : undefined;
  }

  createModelAttempt(value: ModelAttempt): void {
    this.database.db.prepare(`INSERT INTO model_attempts(
      id, run_id, operation_id, attempt_number, previous_attempt_id, retry_of_attempt_id,
      context_projection_id, request_artifact_id, event_artifact_id, provider_profile_json,
      capabilities_json, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.runId, value.operationId, value.attemptNumber, value.previousAttemptId ?? null,
        value.retryOfAttemptId ?? null, value.contextProjectionId, value.requestArtifactId ?? null,
        value.eventArtifactId ?? null, JSON.stringify(value.providerProfile), JSON.stringify(value.capabilities),
        value.status, value.startedAt);
  }

  finishModelAttempt(id: string, status: ModelAttemptStatus, fields: {
    readonly endedAt: string; readonly finishReason?: string; readonly usage?: unknown;
    readonly providerResponseId?: string; readonly error?: unknown; readonly retryDecision?: unknown;
    readonly requestArtifactId?: string; readonly eventArtifactId?: string;
  }): void {
    this.database.db.prepare(`UPDATE model_attempts SET status=?, ended_at=?, finish_reason=?, usage_json=?,
      provider_response_id=?, error_json=?, retry_decision_json=?,
      request_artifact_id=COALESCE(?, request_artifact_id), event_artifact_id=COALESCE(?, event_artifact_id)
      WHERE id=?`)
      .run(status, fields.endedAt, fields.finishReason ?? null,
        fields.usage === undefined ? null : JSON.stringify(fields.usage), fields.providerResponseId ?? null,
        fields.error === undefined ? null : JSON.stringify(fields.error),
        fields.retryDecision === undefined ? null : JSON.stringify(fields.retryDecision),
        fields.requestArtifactId ?? null, fields.eventArtifactId ?? null, id);
  }

  listModelAttempts(runId: string): readonly ModelAttempt[] {
    return (this.database.db.prepare("SELECT * FROM model_attempts WHERE run_id = ? ORDER BY attempt_number")
      .all(runId) as Row[]).map(attemptFromRow);
  }

  setAttemptRetryDecision(id: string, decision: unknown): void {
    this.database.db.prepare("UPDATE model_attempts SET retry_decision_json = ? WHERE id = ?")
      .run(JSON.stringify(decision), id);
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

function artifactFromRow(row: Row): ArtifactMetadata {
  return { id: String(row.id), kind: String(row.kind) as ArtifactMetadata["kind"],
    mediaType: String(row.media_type), relativePath: String(row.relative_path),
    status: String(row.status) as ArtifactMetadata["status"], byteLength: Number(row.byte_length),
    createdAt: String(row.created_at), ...(row.sha256 === null ? {} : { sha256: String(row.sha256) }),
    ...(row.finalized_at === null ? {} : { finalizedAt: String(row.finalized_at) }) };
}
function contextFromRow(row: Row): ContextProjection {
  return { id: String(row.id), runId: String(row.run_id), projectorId: String(row.projector_id),
    projectorVersion: String(row.projector_version),
    includedRecordIds: JSON.parse(String(row.included_record_ids_json)) as string[],
    excludedRecords: JSON.parse(String(row.excluded_records_json)) as { recordId: string; reason: string }[],
    content: JSON.parse(String(row.content_json)) as ContextProjection["content"], createdAt: String(row.created_at),
    ...(row.request_hash === null ? {} : { requestHash: String(row.request_hash) }) };
}
function attemptFromRow(row: Row): ModelAttempt {
  return { id: String(row.id), runId: String(row.run_id), operationId: String(row.operation_id),
    attemptNumber: Number(row.attempt_number), contextProjectionId: String(row.context_projection_id),
    providerProfile: JSON.parse(String(row.provider_profile_json)) as ModelAttempt["providerProfile"],
    capabilities: JSON.parse(String(row.capabilities_json)) as ModelAttempt["capabilities"],
    status: String(row.status) as ModelAttemptStatus, startedAt: String(row.started_at),
    ...(row.previous_attempt_id === null ? {} : { previousAttemptId: String(row.previous_attempt_id) }),
    ...(row.retry_of_attempt_id === null ? {} : { retryOfAttemptId: String(row.retry_of_attempt_id) }),
    ...(row.request_artifact_id === null ? {} : { requestArtifactId: String(row.request_artifact_id) }),
    ...(row.event_artifact_id === null ? {} : { eventArtifactId: String(row.event_artifact_id) }),
    ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    ...(row.finish_reason === null ? {} : { finishReason: String(row.finish_reason) }),
    ...(row.usage_json === null ? {} : { usage: JSON.parse(String(row.usage_json)) as NonNullable<ModelAttempt["usage"]> }),
    ...(row.provider_response_id === null ? {} : { providerResponseId: String(row.provider_response_id) }),
    ...(row.error_json === null ? {} : { error: JSON.parse(String(row.error_json)) as NonNullable<ModelAttempt["error"]> }),
    ...(row.retry_decision_json === null ? {} : { retryDecision: JSON.parse(String(row.retry_decision_json)) as NonNullable<ModelAttempt["retryDecision"]> }) };
}
