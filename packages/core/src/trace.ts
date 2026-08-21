export interface TraceRedactor {
  redact(value: unknown): unknown;
}

const sensitiveKey = /^(authorization|cookie|credential|password|secret|token|api[-_]?key)$/i;

export const defaultTraceRedactor: TraceRedactor = {
  redact(value: unknown): unknown { return redactValue(value, new WeakSet<object>()); },
};

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? "[redacted]" : redactValue(item, seen),
  ]));
}
