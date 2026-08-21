import assert from "node:assert/strict";
import test from "node:test";
import { ToolDispatcher } from "../dist/tool-dispatcher.js";

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
  const result = await dispatcher.dispatch("effect", {}, {
    sessionId: "session",
    runId: "run",
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { output: "substituted" });
});
