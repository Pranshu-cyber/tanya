import type { TanyaTool, ToolContext, ToolResult } from "./types";
import { defaultTools } from "./fsTools";

export type ToolExecutionOptions = {
  onProgress?: ToolContext["onProgress"];
  signal?: AbortSignal;
};

export class ToolRegistry {
  private readonly tools = new Map<string, TanyaTool>();

  constructor(tools: TanyaTool[] = defaultTools()) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  register(tool: TanyaTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): TanyaTool[] {
    return [...this.tools.values()];
  }

  get(name: string): TanyaTool | undefined {
    return this.tools.get(name);
  }

  run(tool: TanyaTool, input: unknown, context: ToolContext, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const runContext: ToolContext = { ...context };
    if (options.onProgress) runContext.onProgress = options.onProgress;
    if (options.signal) runContext.signal = options.signal;
    return tool.run(input, runContext);
  }
}
