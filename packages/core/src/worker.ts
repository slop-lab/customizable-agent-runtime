export type WorkspaceHandle = string & { readonly __workspaceHandle: unique symbol };

interface WorkerRequestBase {
  readonly operationId: string;
  readonly workspace: WorkspaceHandle;
  readonly deadline: string;
  readonly cwd?: string;
}

export type WorkerRequest =
  | (WorkerRequestBase & { readonly type: "readFile"; readonly path: string })
  | (WorkerRequestBase & { readonly type: "shell"; readonly command: string });

export type WorkerResponse =
  | { readonly ok: true; readonly output: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: "invalid-scope" | "timeout" | "cancelled" | "output-limit" | "worker-failed";
      readonly message: string; readonly uncertain?: boolean };

export interface ExecutionWorker {
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse>;
}

export class FakeWorker implements ExecutionWorker {
  readonly requests: WorkerRequest[] = [];
  constructor(private readonly handler: (request: WorkerRequest, signal: AbortSignal) => WorkerResponse | Promise<WorkerResponse>) {}
  async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse> {
    this.requests.push(request);
    return this.handler(request, signal);
  }
}
