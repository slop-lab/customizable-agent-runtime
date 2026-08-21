import assert from "node:assert/strict";
import test from "node:test";
import { ToolDispatcher } from "../dist/tool-dispatcher.js";

const context = {
  sessionId: "session",
  runId: "run",
  operationId: "operation",
  workspace: "workspace",
  deadline: "2026-08-21T00:01:00.000Z",
  signal: new AbortController().signal,
};

const tool = {
  description: { name: "effect", description: "A tool with an observable effect." },
  async execute() {
    return { output: "executed" };
  },
};

test("middleware can substitute a tool result without executing the tool", async () => {
  const middleware = {
    async before() {
      return { type: "substitute", result: { output: "substituted" } };
    },
  };
  const dispatcher = new ToolDispatcher([tool], [middleware]);
  const result = await dispatcher.dispatch("effect", {}, context);

  assert.deepEqual(result, { output: "substituted" });
});

test("validation occurs before execution and redirected calls re-enter middleware", async () => {
  let executions = 0;
  const tool = {
    description: { name: "target", description: "target", validateInput: (input) => typeof input === "string" ? undefined : "string required" },
    async execute(input) { executions++; return { output: input }; },
  };
  const redirect = { description: { name: "source", description: "source" }, async execute() { throw new Error("not reached"); } };
  const middleware = { async before(description) {
    return description.name === "source" ? { type: "redirect", toolName: "target", input: "redirected" } : { type: "continue" };
  } };
  const dispatcher = new ToolDispatcher([tool, redirect], [middleware]);
  await assert.rejects(() => dispatcher.dispatch("target", 1, context), (error) => error.code === "validation");
  assert.deepEqual(await dispatcher.dispatch("source", {}, context), { output: "redirected" });
  assert.equal(executions, 1);
});
