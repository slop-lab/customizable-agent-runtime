import { randomUUID } from "node:crypto";
import type {
  ModelContent,
  Provider,
  RecordEntry,
  RecordKind,
  Run,
  RuntimeEvent,
  Session,
} from "./contracts.js";
import { ToolDispatcher } from "./tool-dispatcher.js";

export class Runtime {
  readonly #sessions = new Map<string, Session>();
  readonly #runs = new Map<string, Run>();
  readonly #records = new Map<string, RecordEntry[]>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(
    private readonly provider: Provider,
    private readonly tools: ToolDispatcher,
  ) {}

  createSession(): Session {
    const session = { id: randomUUID(), createdAt: new Date().toISOString() };
    this.#sessions.set(session.id, session);
    this.#records.set(session.id, []);
    this.#emit("session.created", session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  getRun(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  getRecords(sessionId: string): readonly RecordEntry[] {
    return this.#records.get(sessionId) ?? [];
  }

  capabilities() {
    return {
      apiVersion: "v1",
      provider: { id: this.provider.id, ...this.provider.capabilities },
      tools: this.tools.describe(),
    } as const;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  cancelRun(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(sessionId: string, input: string): Promise<Run> {
    if (!this.#sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);

    const controller = new AbortController();
    const started: Run = {
      id: randomUUID(), sessionId, status: "running", startedAt: new Date().toISOString(),
    };
    this.#runs.set(started.id, started);
    this.#controllers.set(started.id, controller);
    this.#emit("run.started", started);
    this.#append(sessionId, started.id, "user", { text: input });

    try {
      const request = {
        sessionId,
        runId: started.id,
        records: this.getRecords(sessionId),
        tools: this.tools.describe(),
        signal: controller.signal,
      };
      for await (const chunk of this.provider.stream(request)) {
        await this.#handleContent(sessionId, started.id, chunk.content, controller.signal);
      }
      const finished = this.#finish(started, controller.signal.aborted ? "cancelled" : "completed");
      return finished;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelled) this.#append(sessionId, started.id, "error", { message });
      return this.#finish(started, cancelled ? "cancelled" : "failed", cancelled ? undefined : message);
    } finally {
      this.#controllers.delete(started.id);
    }
  }

  async #handleContent(sessionId: string, runId: string, content: ModelContent, signal: AbortSignal) {
    if (content.type === "text") {
      this.#append(sessionId, runId, "assistant", content);
      return;
    }
    this.#append(sessionId, runId, "tool-call", content);
    const result = await this.tools.dispatch(content.toolName, content.input, { sessionId, runId, signal });
    this.#append(sessionId, runId, "tool-result", { callId: content.callId, ...result });
  }

  #append(sessionId: string, runId: string, kind: RecordKind, data: unknown) {
    const record: RecordEntry = {
      id: randomUUID(), sessionId, runId, kind, data, createdAt: new Date().toISOString(),
    };
    this.#records.get(sessionId)?.push(record);
    this.#emit("record.appended", record);
  }

  #finish(started: Run, status: Run["status"], error?: string): Run {
    const finished: Run = {
      ...started,
      status,
      endedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    };
    this.#runs.set(finished.id, finished);
    this.#emit("run.finished", finished);
    return finished;
  }

  #emit(type: RuntimeEvent["type"], data: unknown) {
    const event: RuntimeEvent = {
      id: randomUUID(), type, data, occurredAt: new Date().toISOString(),
    };
    for (const listener of this.#listeners) listener(event);
  }
}
