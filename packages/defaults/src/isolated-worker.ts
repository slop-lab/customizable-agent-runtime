import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ExecutionWorker,
  StoredWorkerExecutionManifest,
  WorkerLease,
  WorkerLifecycleSnapshot,
  WorkerRequest,
  WorkerResponse,
  WorkspaceHandle,
} from "@car/core";
import { ArtifactIngressStore } from "@car/core";
import type {
  IsolatedWorkerChildMessage,
  IsolatedWorkerConfiguration,
  IsolatedWorkerHostMessage,
  IsolatedWorkerHostPayload,
} from "./isolated-worker-protocol.js";

export interface ProcessIsolatedWorkerOptions {
  readonly workspace: WorkspaceHandle;
  readonly root: string;
  readonly artifactIngress?: ArtifactIngressStore;
  readonly maximumInlineOutputBytes?: number;
  readonly maximumArtifactBytes?: number;
  readonly leaseTtlMs?: number;
  readonly startupTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

interface ReadyWorker {
  readonly lease: WorkerLease;
  readonly executionManifest: StoredWorkerExecutionManifest;
}

interface PendingRequest {
  readonly request: WorkerRequest;
  readonly leaseId: string;
  readonly resolve: (response: WorkerResponse) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export class ProcessIsolatedWorker implements ExecutionWorker {
  readonly identity = { id: "defaults.worker.process-isolated", version: "1",
    configuration: { isolation: "process", protocol: "json-lines-v1" } } as const;
  readonly #configuration: IsolatedWorkerConfiguration;
  readonly #startupTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | undefined;
  #ready: ReadyWorker | undefined;
  #starting: Promise<ReadyWorker> | undefined;
  #readyDeferred: Deferred<ReadyWorker> | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #renewals = new Map<string, Deferred<WorkerLease>>();
  #starts = 0;
  #closed = false;

  constructor(options: ProcessIsolatedWorkerOptions) {
    const maximumInlineOutputBytes = options.maximumInlineOutputBytes ?? 1_048_576;
    const maximumArtifactBytes = options.maximumArtifactBytes ?? options.artifactIngress?.maximumBytes ?? 16 * 1024 * 1024;
    if (options.artifactIngress !== undefined && maximumArtifactBytes > options.artifactIngress.maximumBytes) {
      throw new Error("Worker artifact limit exceeds the ingress-store limit");
    }
    this.#configuration = { workspace: options.workspace, root: options.root,
      maximumInlineOutputBytes, maximumArtifactBytes, leaseTtlMs: options.leaseTtlMs ?? 30_000,
      environment: options.environment ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      ...(options.artifactIngress === undefined ? {} : { ingressRoot: options.artifactIngress.root }) };
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  }

  async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse> {
    if (signal.aborted) return cancelled(request);
    let ready: ReadyWorker;
    try { ready = await this.#ensureReady(); }
    catch (error) { return failed(request, error instanceof Error ? error.message : String(error)); }
    if (signal.aborted) return cancelled(request);
    const id = randomUUID();
    return new Promise<WorkerResponse>((resolve) => {
      const onAbort = () => { try { this.#write({ type: "cancel", id }); } catch { /* exit reconciliation owns result */ } };
      this.#pending.set(id, { request, leaseId: ready.lease.id, resolve, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
      try { this.#write({ type: "execute", id, leaseId: ready.lease.id, request }); }
      catch (error) {
        signal.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        resolve(failed(request, error instanceof Error ? error.message : String(error)));
      }
    });
  }

  lifecycle(): WorkerLifecycleSnapshot {
    if (this.#closed) return { state: "closed", restarts: Math.max(0, this.#starts - 1) };
    if (this.#ready === undefined) return { state: "idle", restarts: Math.max(0, this.#starts - 1) };
    return { state: leaseExpired(this.#ready.lease) ? "expired" : "ready", lease: this.#ready.lease,
      restarts: Math.max(0, this.#starts - 1) };
  }

  async reconcile(): Promise<WorkerLifecycleSnapshot> {
    if (this.#ready !== undefined && leaseExpired(this.#ready.lease) && this.#pending.size === 0) this.#terminate();
    return this.lifecycle();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminate();
  }

  async #ensureReady(): Promise<ReadyWorker> {
    if (this.#closed) throw new Error("Worker is closed");
    if (this.#ready !== undefined && !leaseExpired(this.#ready.lease)) {
      const remaining = Date.parse(this.#ready.lease.expiresAt) - Date.now();
      if (remaining <= this.#configuration.leaseTtlMs / 2) await this.#renew(this.#ready);
      return this.#ready!;
    }
    if (this.#child !== undefined) this.#terminate();
    return this.#start();
  }

  #start(): Promise<ReadyWorker> {
    if (this.#starting !== undefined) return this.#starting;
    const host = fileURLToPath(new URL("./isolated-worker-host.js", import.meta.url));
    const child = spawn(process.execPath, [host], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#starts++;
    this.#child = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(child, line));
    child.once("exit", (code, signal) => this.#handleExit(child,
      `Worker process exited (${code ?? signal ?? "unknown"})${stderr.length === 0 ? "" : `: ${stderr}`}`));
    child.once("error", (error) => this.#handleExit(child, `Worker process error: ${error.message}`));
    const deferred = createDeferred<ReadyWorker>();
    this.#readyDeferred = deferred;
    const timer = setTimeout(() => deferred.reject(new Error("Worker startup timed out")), this.#startupTimeoutMs);
    timer.unref();
    this.#starting = deferred.promise.catch((error: unknown) => {
      this.#terminate(error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      this.#starting = undefined;
      this.#readyDeferred = undefined;
    });
    this.#write({ type: "initialize", configuration: this.#configuration });
    return this.#starting;
  }

  async #renew(ready: ReadyWorker): Promise<void> {
    const id = randomUUID();
    const deferred = createDeferred<WorkerLease>();
    this.#renewals.set(id, deferred);
    this.#write({ type: "renew", id, leaseId: ready.lease.id });
    const timer = setTimeout(() => deferred.reject(new Error("Worker lease renewal timed out")), this.#startupTimeoutMs);
    timer.unref();
    try {
      const lease = await deferred.promise;
      if (lease.id !== ready.lease.id || lease.acquiredAt !== ready.lease.acquiredAt || leaseExpired(lease)) {
        throw new Error("Worker returned an invalid lease renewal");
      }
      if (this.#ready?.lease.id === lease.id) this.#ready = { ...this.#ready, lease };
    } catch (error) {
      this.#terminate(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { clearTimeout(timer); this.#renewals.delete(id); }
  }

  #handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.#child) return;
    let message: IsolatedWorkerChildMessage;
    try { message = JSON.parse(line) as IsolatedWorkerChildMessage; }
    catch { this.#terminate("Worker emitted invalid JSON"); return; }
    if (message.version !== 1) { this.#terminate("Worker emitted an unsupported protocol version"); return; }
    if (message.type === "ready") {
      this.#ready = { lease: message.lease, executionManifest: message.executionManifest };
      this.#readyDeferred?.resolve(this.#ready);
      return;
    }
    if (message.type === "renewed") {
      this.#renewals.get(message.id)?.resolve(message.lease);
      return;
    }
    if (message.type === "protocol-error") {
      if (message.id !== undefined && this.#renewals.has(message.id)) {
        this.#renewals.get(message.id)?.reject(new Error(message.message));
      } else if (message.id !== undefined && this.#pending.has(message.id)) {
        const pending = this.#pending.get(message.id)!;
        this.#pending.delete(message.id);
        pending.signal.removeEventListener("abort", pending.onAbort);
        const response = failed(pending.request, message.message);
        pending.resolve(this.#ready === undefined ? response : { ...response, lease: this.#ready.lease,
          executionManifest: this.#ready.executionManifest });
      } else this.#readyDeferred?.reject(new Error(message.message));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    pending.signal.removeEventListener("abort", pending.onAbort);
    if (message.lease.id !== pending.leaseId || this.#ready?.executionManifest.leaseId !== pending.leaseId) {
      pending.resolve({ ok: false, code: "lease-expired", message: "Worker returned a stale lease",
        uncertain: sideEffecting(pending.request) });
      this.#terminate("Worker returned a stale lease");
      return;
    }
    if (Date.parse(message.lease.expiresAt) > Date.parse(this.#ready.lease.expiresAt)) {
      this.#ready = { ...this.#ready, lease: message.lease };
    }
    const response = { ...message.response, lease: message.lease,
      ...(this.#ready === undefined ? {} : { executionManifest: this.#ready.executionManifest }) } as WorkerResponse;
    pending.resolve(response);
  }

  #handleExit(child: ChildProcessWithoutNullStreams, message: string): void {
    if (child !== this.#child) return;
    const ready = this.#ready;
    this.#child = undefined;
    this.#ready = undefined;
    this.#readyDeferred?.reject(new Error(message));
    for (const renewal of this.#renewals.values()) renewal.reject(new Error(message));
    this.#renewals.clear();
    for (const pending of this.#pending.values()) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      const response = failed(pending.request, message);
      pending.resolve(ready === undefined ? response : { ...response, lease: ready.lease,
        executionManifest: ready.executionManifest });
    }
    this.#pending.clear();
  }

  #terminate(reason = "Worker process was recycled"): void {
    const child = this.#child;
    if (child === undefined) return;
    try { this.#write({ type: "shutdown" }); } catch { /* process already unavailable */ }
    child.kill("SIGTERM");
    this.#handleExit(child, reason);
  }

  #write(message: IsolatedWorkerHostPayload): void {
    if (this.#child === undefined || !this.#child.stdin.writable) throw new Error("Worker process is not writable");
    this.#child.stdin.write(`${JSON.stringify({ version: 1, ...message } satisfies IsolatedWorkerHostMessage)}\n`);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function leaseExpired(lease: WorkerLease): boolean { return Date.now() >= Date.parse(lease.expiresAt); }
function sideEffecting(request: WorkerRequest): boolean {
  return request.type === "writeFile" || request.type === "applyPatch" || request.type === "shell";
}
function failed(request: WorkerRequest, message: string): WorkerResponse {
  return { ok: false, code: "worker-failed", message, uncertain: sideEffecting(request) };
}
function cancelled(request: WorkerRequest): WorkerResponse {
  return { ok: false, code: "cancelled", message: "Operation was cancelled", uncertain: sideEffecting(request) };
}
