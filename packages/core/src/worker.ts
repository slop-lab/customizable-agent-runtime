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

export type WorkerResponse =
  | { readonly ok: true; readonly output: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: "invalid-scope" | "timeout" | "cancelled" | "output-limit" | "worker-failed";
      readonly message: string; readonly uncertain?: boolean };

export interface ExecutionWorker {
  readonly identity?: ConfiguredComponentIdentity;
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse>;
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
import type { ConfiguredComponentIdentity } from "./provenance.js";
