import type { ModelContent, Provider, RecordEntry, RecordKind, Run, RuntimeEvent, Session } from "./contracts.js";
import type { Operation } from "./domain.js";
import { RuntimeError } from "./errors.js";
import { RuntimeRepository } from "./persistence.js";
import { KernelDatabase } from "./storage.js";
import { defaultRuntimeSystem, type RuntimeSystem } from "./system.js";
import { ToolDispatcher } from "./tool-dispatcher.js";

export interface RuntimeOptions { readonly system?: RuntimeSystem; readonly database?: KernelDatabase }

export class Runtime {
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #system: RuntimeSystem;
  readonly #database: KernelDatabase;
  readonly #repository: RuntimeRepository;

  constructor(private readonly provider: Provider, private readonly tools: ToolDispatcher,
    options: RuntimeOptions | RuntimeSystem = {}) {
    const normalized = "clock" in options ? { system: options } : options;
    this.#system = normalized.system ?? defaultRuntimeSystem;
    this.#database = normalized.database ?? new KernelDatabase(":memory:");
    this.#repository = new RuntimeRepository(this.#database);
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
    this.#publishPending();
    return session;
  }

  getSession(id: string): Session | undefined { return this.#repository.getSession(id); }
  getRun(id: string): Run | undefined { return this.#repository.getRun(id); }
  getRecords(sessionId: string): readonly RecordEntry[] { return this.#repository.getRecords(sessionId); }
  getOperations(runId: string): readonly Operation[] { return this.#repository.listOperations(runId); }

  capabilities() { return { apiVersion: "v1", provider: { id: this.provider.id, ...this.provider.capabilities },
    tools: this.tools.describe() } as const; }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener); this.#publishPending();
    return () => this.#listeners.delete(listener);
  }

  cancelRun(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller) return false;
    controller.abort(new RuntimeError("cancelled", `Run cancelled: ${id}`));
    return true;
  }

  async run(sessionId: string, input: string): Promise<Run> {
    if (!this.getSession(sessionId)) throw new RuntimeError("not-found", `Unknown session: ${sessionId}`);
    const controller = new AbortController();
    const started = await this.#database.writer.run(() => {
      const now = this.#system.clock.now();
      const run: Run = { id: this.#system.ids.next(), sessionId, status: "running", startedAt: now };
      const operation: Operation = { id: this.#system.ids.next(), runId: run.id, kind: "run", status: "running", startedAt: now };
      const record = this.#record(sessionId, run.id, "user", { text: input });
      this.#repository.database.transaction(() => this.#repository.createRun(run, operation, record, [
        this.#event("run.started", run), this.#event("record.appended", record),
      ]));
      return { run, operation };
    });
    this.#controllers.set(started.run.id, controller); this.#publishPending();
    try {
      const request = { sessionId, runId: started.run.id, records: this.getRecords(sessionId),
        tools: this.tools.describe(), signal: controller.signal };
      for await (const chunk of this.provider.stream(request)) {
        controller.signal.throwIfAborted();
        await this.#handleContent(sessionId, started.run.id, chunk.content, controller.signal);
      }
      return await this.#finish(started.run, started.operation.id,
        controller.signal.aborted ? "cancelled" : "completed");
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelled) await this.#append(sessionId, started.run.id, "error", { message });
      return await this.#finish(started.run, started.operation.id, cancelled ? "cancelled" : "failed",
        cancelled ? undefined : message);
    } finally { this.#controllers.delete(started.run.id); }
  }

  close(): void { this.#database.close(); }

  async #handleContent(sessionId: string, runId: string, content: ModelContent, signal: AbortSignal) {
    if (content.type === "text") { await this.#append(sessionId, runId, "assistant", content); return; }
    await this.#append(sessionId, runId, "tool-call", content);
    const result = await this.tools.dispatch(content.toolName, content.input, { sessionId, runId, signal });
    await this.#append(sessionId, runId, "tool-result", { callId: content.callId, ...result });
  }

  async #append(sessionId: string, runId: string, kind: RecordKind, data: unknown): Promise<void> {
    await this.#database.writer.run(() => {
      const record = this.#record(sessionId, runId, kind, data);
      this.#repository.appendRecord(record, this.#event("record.appended", record));
    });
    this.#publishPending();
  }

  #record(sessionId: string, runId: string, kind: RecordKind, data: unknown): RecordEntry {
    return { id: this.#system.ids.next(), sessionId, runId, kind, data, createdAt: this.#system.clock.now() };
  }

  async #finish(started: Run, operationId: string, status: Run["status"], error?: string): Promise<Run> {
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
