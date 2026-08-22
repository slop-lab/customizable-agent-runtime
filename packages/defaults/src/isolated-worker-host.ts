import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { ArtifactIngressStore, createWorkerExecutionManifest, type WorkerLease } from "@car/core";
import { LocalDevelopmentWorker } from "./local-worker.js";
import type {
  IsolatedWorkerChildMessage,
  IsolatedWorkerChildPayload,
  IsolatedWorkerConfiguration,
  IsolatedWorkerHostMessage,
} from "./isolated-worker-protocol.js";

let configuration: IsolatedWorkerConfiguration | undefined;
let worker: LocalDevelopmentWorker | undefined;
let lease: WorkerLease | undefined;
const active = new Map<string, AbortController>();
let shuttingDown = false;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void handleLine(line);
});
lines.once("close", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleLine(line: string): Promise<void> {
  let message: IsolatedWorkerHostMessage | undefined;
  try {
    message = JSON.parse(line) as IsolatedWorkerHostMessage;
    if (message.version !== 1) throw new Error("Unsupported worker protocol version");
    await handleMessage(message);
  } catch (error) {
    send({ type: "protocol-error",
      ...(message !== undefined && "id" in message ? { id: message.id } : {}),
      message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleMessage(message: IsolatedWorkerHostMessage): Promise<void> {
  if (message.type === "initialize") {
    if (worker !== undefined) throw new Error("Worker is already initialized");
    configuration = validateConfiguration(message.configuration);
    const artifactIngress = configuration.ingressRoot === undefined ? undefined
      : new ArtifactIngressStore(configuration.ingressRoot, configuration.maximumArtifactBytes);
    worker = new LocalDevelopmentWorker({ workspace: configuration.workspace, root: configuration.root,
      maxOutputBytes: configuration.maximumInlineOutputBytes,
      maxArtifactBytes: configuration.maximumArtifactBytes,
      environment: configuration.environment,
      ...(artifactIngress === undefined ? {} : { artifactIngress }) });
    lease = issueLease(configuration.leaseTtlMs);
    const executionManifest = createWorkerExecutionManifest({ version: 1,
      worker: { id: "defaults.worker.process-isolated", version: "1" }, leaseId: lease.id,
      startedAt: lease.acquiredAt,
      runtime: { name: "node", version: process.version, platform: process.platform,
        architecture: process.arch },
      workspace: { handle: configuration.workspace },
      environment: { keys: Object.keys(configuration.environment) },
      isolation: { kind: "process", filesystem: "workspace-scoped", environment: "explicit-projection" },
      resourceLimits: { maximumInlineOutputBytes: configuration.maximumInlineOutputBytes,
        maximumArtifactBytes: configuration.maximumArtifactBytes },
      requestTypes: ["readFile", "list", "search", "writeFile", "applyPatch", "shell", "gitStatus"],
    });
    send({ type: "ready", lease, executionManifest });
    return;
  }
  if (message.type === "shutdown") { shutdown(); return; }
  if (message.type === "cancel") { active.get(message.id)?.abort(new Error("Worker request cancelled")); return; }
  if (worker === undefined || configuration === undefined || lease === undefined) {
    throw new Error("Worker has not been initialized");
  }
  if (message.type === "renew") {
    if (message.leaseId !== lease.id || leaseExpired(lease)) {
      send({ type: "protocol-error", id: message.id, message: "Worker lease expired" });
      return;
    }
    lease = { ...lease, expiresAt: new Date(Date.now() + configuration.leaseTtlMs).toISOString() };
    send({ type: "renewed", id: message.id, lease });
    return;
  }
  if (message.leaseId !== lease.id || leaseExpired(lease)) {
    send({ type: "result", id: message.id, lease,
      response: { ok: false, code: "lease-expired", message: "Worker lease expired" } });
    return;
  }
  const controller = new AbortController();
  active.set(message.id, controller);
  try {
    const response = await worker.execute(message.request, controller.signal);
    send({ type: "result", id: message.id, lease, response });
  } finally {
    active.delete(message.id);
  }
}

function validateConfiguration(value: IsolatedWorkerConfiguration): IsolatedWorkerConfiguration {
  if (typeof value.root !== "string" || value.root.length === 0 || typeof value.workspace !== "string" ||
    !Number.isSafeInteger(value.maximumInlineOutputBytes) || value.maximumInlineOutputBytes < 1 ||
    !Number.isSafeInteger(value.maximumArtifactBytes) || value.maximumArtifactBytes < value.maximumInlineOutputBytes ||
    !Number.isSafeInteger(value.leaseTtlMs) || value.leaseTtlMs < 10) {
    throw new Error("Invalid isolated worker configuration");
  }
  return value;
}

function issueLease(ttlMs: number): WorkerLease {
  const now = new Date();
  return { id: randomUUID(), acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
}

function leaseExpired(value: WorkerLease): boolean { return Date.now() >= Date.parse(value.expiresAt); }

function send(message: IsolatedWorkerChildPayload): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...message } satisfies IsolatedWorkerChildMessage)}\n`);
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of active.values()) controller.abort(new Error("Worker host shutting down"));
  lines.close();
  process.exitCode = 0;
  if (active.size === 0) process.exit();
  else setTimeout(() => process.exit(), 100).unref();
}
