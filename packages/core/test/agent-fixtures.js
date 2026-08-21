import { Runtime, ToolDispatcher } from "../dist/index.js";

export function providerFrom(invoke) {
  return {
    id: "fake",
    profile: { id: "fake", provider: "fake", model: "fake", endpoint: "fake://local", credentialHandle: "none" },
    capabilities: { version: 1, values: { "core.streaming.text": { supported: true }, "core.tools.calls": { supported: true } } },
    async invoke(request) {
      request.recordRequest({ input: request.context.content });
      const turn = await invoke(request);
      request.recordEvent("interaction.completed", turn);
      return turn;
    },
  };
}

export const appendOneTurnDriver = {
  id: "test.driver", version: "1",
  async run(context) {
    const turn = await context.invokeModel();
    for (const content of turn.content) {
      await context.append(content);
      if (content.type === "tool-call") await context.dispatch(content);
    }
  },
};

export function createTestRuntime(provider, tools = [], options = {}, driver = appendOneTurnDriver) {
  return new Runtime(provider, driver, new ToolDispatcher(tools), options);
}
