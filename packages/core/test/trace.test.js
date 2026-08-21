import assert from "node:assert/strict";
import test from "node:test";
import { defaultTraceRedactor } from "../dist/index.js";

test("default trace redaction removes structured credential fields recursively", () => {
  assert.deepEqual(defaultTraceRedactor.redact({ token: "raw", nested: { apiKey: "raw", safe: "value" } }), {
    token: "[redacted]", nested: { apiKey: "[redacted]", safe: "value" },
  });
});
