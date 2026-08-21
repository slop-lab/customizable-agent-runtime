import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDriver, ContextProjection, JsonObject, ModelAttempt, ModelAttemptResult, ModelProvider,
  NormalizedContent,
} from "./agent-contracts.js";
import { ModelAttemptFailure, ProviderInvocationError } from "./agent-contracts.js";
import { ArtifactStore, type ArtifactMetadata } from "./artifacts.js";
import type {
  RecordEntry, RecordKind, Run, RunSummary, RuntimeEvent, Session, SessionSummary, ToolResult,
} from "./contracts.js";
import { DefaultContextProjector } from "./context-projector.js";
import type { Operation, OperationStatus } from "./domain.js";
import { RuntimeError } from "./errors.js";
import { RuntimeRepository } from "./persistence.js";
import { KernelDatabase } from "./storage.js";
import { defaultRuntimeSystem, type RuntimeSystem } from "./system.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { defaultTraceRedactor, type TraceRedactor } from "./trace.js";
import type { WorkspaceHandle } from "./worker.js";
import { aggregateUsage, type UsageFilter, type UsageReport } from "./usage.js";

export interface RuntimeOptions {
  readonly system?: RuntimeSystem;
  readonly database?: KernelDatabase;
  readonly artifactStore?: ArtifactStore;
  readonly workspace?: WorkspaceHandle;
  readonly toolTimeoutMs?: number;
  readonly redactor?: TraceRedactor;
}

export interface RunExecution {
  readonly run: Run;
  readonly completion: Promise<Run>;
  cancel(): boolean;
}

export class Runtime {
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #system: RuntimeSystem;
  readonly #database: KernelDatabase;
  readonly #repository: RuntimeRepository;
  readonly #artifactStore: ArtifactStore;
  readonly #temporaryArtifactRoot: string | undefined;
  readonly #workspace: WorkspaceHandle;
  readonly #toolTimeoutMs: number;
  readonly #redactor: TraceRedactor;
  readonly #projector = new DefaultContextProjector();

  constructor(
    private readonly provider: ModelProvider,
    private readonly driver: AgentDriver,
    private readonly tools: ToolDispatcher,
    options: RuntimeOptions = {},
  ) {
    this.#system = options.system ?? defaultRuntimeSystem;
    this.#database = options.database ?? new KernelDatabase(":memory:");
    this.#repository = new RuntimeRepository(this.#database);
    this.#temporaryArtifactRoot = options.artifactStore ? undefined : mkdtempSync(join(tmpdir(), "car-artifacts-"));
    this.#artifactStore = options.artifactStore ?? new ArtifactStore(this.#temporaryArtifactRoot!);
    this.#workspace = options.workspace ?? "default" as WorkspaceHandle;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.#redactor = options.redactor ?? defaultTraceRedactor;
    this.#repository.recoverAbandoned(this.#system.clock.now(), (operation) =>
      this.#event("operation.recovered", { operationId: operation.id, runId: operation.runId }));
  }

  async createSession(idempotencyKey = `session:${this.#system.ids.next()}`): Promise<Session> {
    const session = await this.#database.writer.run(() => {
      const now = this.#system.clock.now();
      return this.#repository.command(idempotencyKey, now, () => {
        const value = { id: this.#system.ids.next(), createdAt: now };
        this.#repository.createSession(value, this.#event("session.created", value));
        return value;
      });
    });
    this.#publishPending(); return session;
  }

  getSession(id: string): Session | undefined { return this.#repository.getSession(id); }
  listSessions(options: { readonly limit?: number } = {}): readonly SessionSummary[] {
    return this.#repository.listSessions(readLimit(options.limit));
  }
  getRun(id: string): Run | undefined { return this.#repository.getRun(id); }
  listRuns(sessionId: string, options: { readonly limit?: number } = {}): readonly RunSummary[] {
    if (!this.getSession(sessionId)) throw new RuntimeError("not-found", `Unknown session: ${sessionId}`);
    return this.#repository.listRuns(sessionId, readLimit(options.limit));
  }
  getRecords(sessionId: string): readonly RecordEntry[] { return this.#repository.getRecords(sessionId); }
  getOperations(runId: string): readonly Operation[] { return this.#repository.listOperations(runId); }
  getModelAttempts(runId: string): readonly ModelAttempt[] { return this.#repository.listModelAttempts(runId); }
  usage(filter: UsageFilter = {}): UsageReport {
    if (filter.sessionId !== undefined && !this.getSession(filter.sessionId)) {
      throw new RuntimeError("not-found", `Unknown session: ${filter.sessionId}`);
    }
    if (filter.runId !== undefined) {
      const run = this.getRun(filter.runId);
      if (!run) throw new RuntimeError("not-found", `Unknown run: ${filter.runId}`);
      if (filter.sessionId !== undefined && run.sessionId !== filter.sessionId) {
        throw new RuntimeError("validation", `Run ${filter.runId} does not belong to session ${filter.sessionId}`);
      }
    }
    return aggregateUsage(this.#repository.listUsageAttempts(filter), filter);
  }
  getContextProjection(id: string): ContextProjection | undefined { return this.#repository.getContextProjection(id); }
  getArtifact(id: string): ArtifactMetadata | undefined { return this.#repository.getArtifact(id); }
  readArtifact(id: string): string | undefined {
    const metadata = this.getArtifact(id);
    return metadata === undefined || metadata.status === "partial" ? undefined : this.#artifactStore.read(metadata);
  }

  capabilities() {
    return { apiVersion: "v1", provider: { id: this.provider.id, profile: this.provider.profile,
      capabilities: this.provider.capabilities }, driver: { id: this.driver.id, version: this.driver.version },
      tools: this.tools.describe() } as const;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    try { this.#publishPending(); } catch (error) { this.#listeners.delete(listener); throw error; }
    return () => this.#listeners.delete(listener);
  }

  cancelRun(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller) return false;
    controller.abort(new RuntimeError("cancelled", `Run cancelled: ${id}`));
    return true;
  }

  async run(sessionId: string, input: string): Promise<Run> {
    return (await this.startRun(sessionId, input)).completion;
  }

  async startRun(sessionId: string, input: string): Promise<RunExecution> {
    if (!this.getSession(sessionId)) throw new RuntimeError("not-found", `Unknown session: ${sessionId}`);
    const controller = new AbortController();
    const started = await this.#startRun(sessionId, input);
    this.#controllers.set(started.run.id, controller); this.#publishPending();
    const completion = this.#executeRun(sessionId, started, controller);
    return { run: started.run, completion, cancel: () => this.cancelRun(started.run.id) };
  }

  async #executeRun(sessionId: string, started: { run: Run; operation: Operation },
    controller: AbortController): Promise<Run> {
    try {
      await this.driver.run({
        sessionId, runId: started.run.id, signal: controller.signal,
        records: () => this.getRecords(sessionId), tools: () => this.tools.describe(),
        invokeModel: (options) => this.#invokeModel(started.run.id, sessionId, controller.signal, options),
        recordRetryDecision: (attemptId, decision) => this.#recordRetryDecision(attemptId, decision),
        append: (content) => this.#appendNormalized(sessionId, started.run.id, content, controller.signal),
        dispatch: (call) => this.#dispatchTool(sessionId, started.run.id, call, controller.signal),
      });
      controller.signal.throwIfAborted();
      return await this.#finishRun(started.run, started.operation.id, "completed");
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelled) await this.#append(sessionId, started.run.id, "error", { message });
      return await this.#finishRun(started.run, started.operation.id, cancelled ? "cancelled" : "failed",
        cancelled ? undefined : message);
    } finally { this.#controllers.delete(started.run.id); }
  }

  close(): void {
    this.#database.close();
    if (this.#temporaryArtifactRoot) rmSync(this.#temporaryArtifactRoot, { recursive: true, force: true });
  }

  async #startRun(sessionId: string, input: string): Promise<{ run: Run; operation: Operation }> {
    return this.#database.writer.run(() => {
      const now = this.#system.clock.now();
      const run: Run = { id: this.#system.ids.next(), sessionId, status: "running", startedAt: now };
      const operation: Operation = { id: this.#system.ids.next(), runId: run.id, kind: "run", status: "running", startedAt: now };
      const record = this.#record(sessionId, run.id, "user", { text: input });
      this.#repository.database.transaction(() => this.#repository.createRun(run, operation, record, [
        this.#event("run.started", run), this.#event("record.appended", record),
      ]));
      return { run, operation };
    });
  }

  async #invokeModel(runId: string, sessionId: string, signal: AbortSignal,
    options: { readonly retryOfAttemptId?: string } = {}): Promise<ModelAttemptResult> {
    signal.throwIfAborted();
    const existing = this.#repository.listModelAttempts(runId);
    const attemptNumber = existing.length + 1;
    const now = this.#system.clock.now();
    const attemptId = this.#system.ids.next();
    const operation: Operation = { id: this.#system.ids.next(), runId, kind: "model", status: "running", startedAt: now };
    const context = this.#projector.project(this.#system.ids.next(), runId, this.getRecords(sessionId), now);
    const requestWriter = this.#artifactStore.create(this.#system.ids.next(), "provider-request", "application/json", now);
    const eventWriter = this.#artifactStore.create(this.#system.ids.next(), "provider-events", "application/x-ndjson", now);
    await this.#database.writer.run(() => {
      this.#repository.saveContextProjection(context);
      this.#repository.saveArtifact(requestWriter.metadata); this.#repository.saveArtifact(eventWriter.metadata);
      this.#repository.createOperation(operation, this.#event("operation.started", operation));
      this.#repository.createModelAttempt({ id: attemptId, runId, operationId: operation.id, attemptNumber,
        ...(existing.at(-1) ? { previousAttemptId: existing.at(-1)!.id } : {}), contextProjectionId: context.id,
        ...(options.retryOfAttemptId === undefined ? {} : { retryOfAttemptId: options.retryOfAttemptId }),
        requestArtifactId: requestWriter.metadata.id, eventArtifactId: eventWriter.metadata.id,
        providerProfile: this.provider.profile, capabilities: this.provider.capabilities,
        status: "running", startedAt: now });
    });
    this.#publishPending();
    let requestRecorded = false;
    let sequence = 0;
    try {
      signal.throwIfAborted();
      const turn = await this.provider.invoke({ attemptId, context, tools: this.tools.describe(), signal,
        recordRequest: (payload) => {
          if (requestRecorded) throw new Error("Provider request was recorded more than once");
          requestWriter.append(JSON.stringify(this.#redactor.redact(payload))); requestRecorded = true;
        },
        recordEvent: (eventType, payload) => eventWriter.appendJsonLine({ sequence: ++sequence, eventType,
          receivedAt: this.#system.clock.now(), payload: this.#redactor.redact(payload) }),
      });
      signal.throwIfAborted();
      if (!requestRecorded) throw new Error("Provider did not record its final request");
      const endedAt = this.#system.clock.now();
      const requestArtifact = requestWriter.finalize("completed", endedAt);
      const eventArtifact = eventWriter.finalize("completed", endedAt);
      await this.#database.writer.run(() => {
        this.#repository.saveArtifact(requestArtifact); this.#repository.saveArtifact(eventArtifact);
        this.#repository.finishModelAttempt(attemptId, "completed", { endedAt,
          ...(turn.finishReason === undefined ? {} : { finishReason: turn.finishReason }),
          ...(turn.usage === undefined ? {} : { usage: turn.usage }),
          ...(turn.normalizedUsage === undefined ? {} : { normalizedUsage: turn.normalizedUsage }),
          ...(turn.providerResponseId === undefined ? {} : { providerResponseId: turn.providerResponseId }) });
        this.#repository.finishOperation(operation.id, "completed", endedAt,
          this.#event("operation.finished", { ...operation, status: "completed", endedAt }), turn);
      });
      this.#publishPending(); return { attemptId, ...turn };
    } catch (error) {
      const endedAt = this.#system.clock.now();
      const providerError = error instanceof ProviderInvocationError ? error
        : signal.aborted ? new ProviderInvocationError("provider.cancelled", "Model invocation cancelled", false)
          : new ProviderInvocationError("provider.internal", error instanceof Error ? error.message : String(error), false);
      const status = signal.aborted ? "cancelled" : "failed";
      const requestArtifact = requestWriter.finalize("failed", endedAt);
      const eventArtifact = eventWriter.finalize("failed", endedAt);
      await this.#database.writer.run(() => {
        this.#repository.saveArtifact(requestArtifact); this.#repository.saveArtifact(eventArtifact);
        this.#repository.finishModelAttempt(attemptId, status, { endedAt,
          error: { code: providerError.code, message: providerError.message, retryable: providerError.retryable,
            ...(providerError.details ?? {}) } });
        this.#repository.finishOperation(operation.id, status as OperationStatus, endedAt,
          this.#event("operation.finished", { ...operation, status, endedAt, error: providerError.message }),
          undefined, providerError.message);
      });
      this.#publishPending(); throw new ModelAttemptFailure(attemptId, providerError);
    }
  }

  async #recordRetryDecision(attemptId: string, decision: JsonObject): Promise<void> {
    await this.#database.writer.run(() => this.#repository.setAttemptRetryDecision(attemptId, decision));
  }

  async #appendNormalized(sessionId: string, runId: string, content: NormalizedContent,
    signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (content.type === "text") {
      await this.#append(sessionId, runId, content.role === "user" ? "user" : "assistant", { text: content.text }, signal); return;
    }
    if (content.type === "tool-call") { await this.#append(sessionId, runId, "tool-call", content, signal); return; }
    if (content.type === "tool-result") { await this.#append(sessionId, runId, "tool-result", content, signal); return; }
    await this.#append(sessionId, runId, "provider-native", content, signal);
  }

  async #dispatchTool(sessionId: string, runId: string,
    call: Extract<NormalizedContent, { type: "tool-call" }>, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const operation = await this.#database.writer.run(() => {
      signal.throwIfAborted();
      const now = this.#system.clock.now();
      const value: Operation = { id: this.#system.ids.next(), runId, kind: "tool", status: "running", startedAt: now };
      this.#repository.createOperation(value, this.#event("operation.started", value)); return value;
    });
    this.#publishPending();
    let operationFinished = false;
    try {
      const result = await this.tools.dispatch(call.toolName, call.input, { sessionId, runId,
        operationId: operation.id, workspace: this.#workspace,
        deadline: new Date(Date.parse(this.#system.clock.now()) + this.#toolTimeoutMs).toISOString(), signal });
      signal.throwIfAborted();
      await this.#finishTool(operation, "completed", this.#redactor.redact(result));
      operationFinished = true;
      signal.throwIfAborted();
      await this.#appendNormalized(sessionId, runId, { type: "tool-result", callId: call.callId,
        output: result.output, isError: result.isError === true }, signal);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!operationFinished) {
        await this.#finishTool(operation, signal.aborted ? "cancelled" : "failed", undefined, message);
      }
      if (signal.aborted) throw signal.reason ?? new RuntimeError("cancelled", `Tool operation cancelled: ${operation.id}`);
      const result = { output: message, isError: true };
      await this.#appendNormalized(sessionId, runId, { type: "tool-result", callId: call.callId,
        output: message, isError: true }, signal);
      return result;
    }
  }

  async #finishTool(operation: Operation, status: "completed" | "failed" | "cancelled",
    result?: unknown, error?: string): Promise<void> {
    await this.#database.writer.run(() => {
      const now = this.#system.clock.now();
      this.#repository.finishOperation(operation.id, status, now,
        this.#event("operation.finished", { ...operation, status, endedAt: now,
          ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }), result, error);
    });
    this.#publishPending();
  }

  async #append(sessionId: string, runId: string, kind: RecordKind, data: unknown,
    signal?: AbortSignal): Promise<void> {
    await this.#database.writer.run(() => {
      signal?.throwIfAborted();
      const record = this.#record(sessionId, runId, kind, data);
      this.#repository.appendRecord(record, this.#event("record.appended", record));
    });
    this.#publishPending();
  }

  #record(sessionId: string, runId: string, kind: RecordKind, data: unknown): RecordEntry {
    return { id: this.#system.ids.next(), sessionId, runId, kind,
      data: this.#redactor.redact(data), createdAt: this.#system.clock.now() };
  }

  async #finishRun(started: Run, operationId: string, status: Run["status"], error?: string): Promise<Run> {
    const finished = await this.#database.writer.run(() => {
      const now = this.#system.clock.now();
      const projected: Run = { ...started, status, endedAt: now, ...(error === undefined ? {} : { error }) };
      return this.#repository.finishRun(started.id, operationId, status, now,
        this.#event("run.finished", projected), error);
    });
    this.#publishPending(); return finished;
  }

  #event(type: RuntimeEvent["type"], data: unknown): RuntimeEvent {
    return { id: this.#system.ids.next(), type, data, occurredAt: this.#system.clock.now() };
  }

  #publishPending(): void {
    if (this.#listeners.size === 0) return;
    for (const event of this.#repository.pendingEvents()) {
      for (const listener of this.#listeners) listener(event);
      this.#repository.markPublished(event.sequence, this.#system.clock.now());
    }
  }
}

function readLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RuntimeError("validation", "Limit must be an integer from 1 through 100");
  }
  return value;
}
