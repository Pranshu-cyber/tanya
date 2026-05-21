import { ToolRegistry } from "../../tools/registry";
import { getActiveMcpManager, loadMcpToolsForWorkspace } from "../../mcp/client";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const mcpCommand: CommandDefinition = {
  name: "mcp",
  description: "List configured MCP servers, status, and tools.",
  category: "built-in",
  async handler(_args, ctx) {
    const manager = getActiveMcpManager() ?? await loadMcpToolsForWorkspace({
      cwd: ctx.cwd,
      registry: new ToolRegistry([]),
      sink: ctx.sink,
    });
    const statuses = manager.statuses();
    if (statuses.length === 0) {
      ctx.output.write("No MCP servers configured.\n");
      return;
    }
    ctx.output.write("MCP servers:\n");
    for (const status of statuses) {
      const tools = status.toolNames.length > 0 ? status.toolNames.join(", ") : "-";
      const error = status.error ? ` (${status.error})` : "";
      ctx.output.write(`${status.name}  ${status.status}  ${status.transport}  restarts=${status.restarts}  tools=${tools}${error}\n`);
    }
  },
};

registerCommand(mcpCommand);
