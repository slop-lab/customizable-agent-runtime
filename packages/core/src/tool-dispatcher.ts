import type {
  Tool,
  ToolContext,
  ToolDescription,
  ToolMiddleware,
  ToolResult,
} from "./contracts.js";

export class ToolDispatcher {
  readonly #tools = new Map<string, Tool>();
  readonly #middleware: readonly ToolMiddleware[];

  constructor(tools: readonly Tool[], middleware: readonly ToolMiddleware[] = []) {
    this.#middleware = middleware;
    for (const tool of tools) {
      if (this.#tools.has(tool.description.name)) {
        throw new Error(`Duplicate tool: ${tool.description.name}`);
      }
      this.#tools.set(tool.description.name, tool);
    }
  }

  describe(): readonly ToolDescription[] {
    return [...this.#tools.values()].map((tool) => tool.description);
  }

  async dispatch(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    for (const middleware of this.#middleware) {
      const decision = await middleware.before(tool.description, input, context);
      if (decision.type === "substitute") return decision.result;
    }

    return tool.execute(input, context);
  }
}
