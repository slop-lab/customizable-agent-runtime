import type { ArtifactIngressDescriptorV1 } from "./artifacts.js";
import type { ConfiguredComponentIdentity, StoredWorkerExecutionManifest } from "./provenance.js";

export type WorkspaceHandle = string & { readonly __workspaceHandle: unique symbol };

interface WorkerRequestBase {
  readonly operationId: string;
  readonly workspace: WorkspaceHandle;
  readonly deadline: string;
  readonly cwd?: string;
}

export type WorkerRequest =
  | (WorkerRequestBase & { readonly type: "readFile"; readonly path: string })
  | (WorkerRequestBase & { readonly type: "list"; readonly path: string })
  | (WorkerRequestBase & { readonly type: "search"; readonly query: string; readonly path?: string })
  | (WorkerRequestBase & { readonly type: "writeFile"; readonly path: string; readonly content: string })
  | (WorkerRequestBase & { readonly type: "applyPatch"; readonly patch: string })
  | (WorkerRequestBase & { readonly type: "shell"; readonly command: string })
  | (WorkerRequestBase & { readonly type: "gitStatus" });

export interface WorkerLease {
  readonly id: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface WorkerResponseContext {
  readonly artifact?: ArtifactIngressDescriptorV1;
  readonly lease?: WorkerLease;
  readonly executionManifest?: StoredWorkerExecutionManifest;
}

export type WorkerResponse = (
  | { readonly ok: true; readonly output: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: "invalid-scope" | "timeout" | "cancelled" | "output-limit" |
      "worker-failed" | "lease-expired"; readonly message: string; readonly uncertain?: boolean }
) & WorkerResponseContext;

export interface WorkerLifecycleSnapshot {
  readonly state: "idle" | "ready" | "expired" | "closed";
  readonly lease?: WorkerLease;
  readonly restarts: number;
}

export interface ExecutionWorker {
  readonly identity?: ConfiguredComponentIdentity;
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse>;
  lifecycle?(): WorkerLifecycleSnapshot;
  reconcile?(): Promise<WorkerLifecycleSnapshot>;
  close?(): void;
}

export class FakeWorker implements ExecutionWorker {
  readonly identity = { id: "core.worker.fake", version: "1" } as const;
  readonly requests: WorkerRequest[] = [];
  constructor(private readonly handler: (request: WorkerRequest, signal: AbortSignal) => WorkerResponse | Promise<WorkerResponse>) {}
  async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse> {
    this.requests.push(request);
    return this.handler(request, signal);
  }
}
