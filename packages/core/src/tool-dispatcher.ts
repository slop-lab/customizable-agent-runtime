import type {
  Tool,
  ToolContext,
  ToolDescription,
  ToolMiddleware,
  ToolResult,
} from "./contracts.js";
import { RuntimeError } from "./errors.js";

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
    return this.#dispatch(name, input, context, 0);
  }

  async #dispatch(name: string, initialInput: unknown, context: ToolContext, redirects: number): Promise<ToolResult> {
    if (redirects > 8) throw new RuntimeError("conflict", "Tool redirect limit exceeded");
    const tool = this.#tools.get(name);
    if (!tool) throw new RuntimeError("not-found", `Unknown tool: ${name}`);

    let input = initialInput;
    const validationError = tool.description.validateInput?.(input);
    if (validationError) throw new RuntimeError("validation", validationError, { tool: name });

    for (const middleware of this.#middleware) {
      const decision = await middleware.before(tool.description, input, context);
      if (decision.type === "replace") {
        input = decision.input;
        const replacedError = tool.description.validateInput?.(input);
        if (replacedError) throw new RuntimeError("validation", replacedError, { tool: name });
      }
      if (decision.type === "deny") throw new RuntimeError("validation", decision.message, { tool: name });
      if (decision.type === "suspend") throw new RuntimeError("conflict", `Tool suspended: ${decision.reason}`, { tool: name });
      if (decision.type === "substitute") return decision.result;
      if (decision.type === "redirect") return this.#dispatch(decision.toolName, decision.input, context, redirects + 1);
    }

    return tool.execute(input, context);
  }
}
