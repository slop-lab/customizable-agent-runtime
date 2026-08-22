import type { StoredWorkerExecutionManifest, WorkerLease, WorkerRequest, WorkerResponse, WorkspaceHandle } from "@car/core";

export interface IsolatedWorkerConfiguration {
  readonly workspace: WorkspaceHandle;
  readonly root: string;
  readonly ingressRoot?: string;
  readonly maximumInlineOutputBytes: number;
  readonly maximumArtifactBytes: number;
  readonly leaseTtlMs: number;
  readonly environment: Readonly<Record<string, string>>;
}

export type IsolatedWorkerHostPayload =
  | { readonly type: "initialize"; readonly configuration: IsolatedWorkerConfiguration }
  | { readonly type: "execute"; readonly id: string; readonly leaseId: string; readonly request: WorkerRequest }
  | { readonly type: "cancel"; readonly id: string }
  | { readonly type: "renew"; readonly id: string; readonly leaseId: string }
  | { readonly type: "shutdown" };
export type IsolatedWorkerHostMessage = { readonly version: 1 } & IsolatedWorkerHostPayload;

export type IsolatedWorkerChildPayload =
  | { readonly type: "ready"; readonly lease: WorkerLease; readonly executionManifest: StoredWorkerExecutionManifest }
  | { readonly type: "result"; readonly id: string; readonly lease: WorkerLease; readonly response: WorkerResponse }
  | { readonly type: "renewed"; readonly id: string; readonly lease: WorkerLease }
  | { readonly type: "protocol-error"; readonly id?: string; readonly message: string };
export type IsolatedWorkerChildMessage = { readonly version: 1 } & IsolatedWorkerChildPayload;
