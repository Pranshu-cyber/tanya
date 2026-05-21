import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const clearCommand: CommandDefinition = {
  name: "clear",
  description: "Clear the active conversation history.",
  category: "built-in",
  handler(_args, ctx) {
    if (ctx.clearHistory) {
      ctx.clearHistory();
    } else if (ctx.history) {
      ctx.history.length = 0;
    }
    ctx.output.write("Conversation history cleared.\n");
  },
};

registerCommand(clearCommand);
