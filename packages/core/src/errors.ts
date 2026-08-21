export type RuntimeErrorCode =
  | "validation"
  | "conflict"
  | "not-found"
  | "cancelled"
  | "internal";

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
