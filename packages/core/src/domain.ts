import { RuntimeError } from "./errors.js";

export type OperationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  pending: ["running", "cancelled", "abandoned"],
  running: ["completed", "failed", "cancelled", "abandoned"],
  completed: [],
  failed: [],
  cancelled: [],
  abandoned: [],
};

export function assertOperationTransition(from: OperationStatus, to: OperationStatus): void {
  if (!transitions[from].includes(to)) {
    throw new RuntimeError("conflict", `Invalid operation transition: ${from} -> ${to}`, {
      from,
      to,
    });
  }
}

export interface Operation {
  readonly id: string;
  readonly runId: string;
  readonly kind: "run" | "model" | "tool";
  readonly status: OperationStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly error?: string;
  readonly result?: unknown;
}
