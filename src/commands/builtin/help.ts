import { commandIsAvailable, listCommands, registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const helpCommand: CommandDefinition = {
  name: "help",
  description: "List available slash commands.",
  category: "built-in",
  async handler(_args, ctx) {
    const commands = [];
    for (const command of listCommands()) {
      if (await commandIsAvailable(command, ctx)) commands.push(command);
    }
    ctx.output.write("Built-in commands:\n");
    for (const command of commands.filter((candidate) => (candidate.category ?? "built-in") === "built-in")) {
      ctx.output.write(`/${command.name} — ${command.description}\n`);
    }
    const projectCommands = commands.filter((candidate) => candidate.category === "project");
    if (projectCommands.length > 0) {
      ctx.output.write("Project commands:\n");
      for (const command of projectCommands) {
        ctx.output.write(`/${command.name} — ${command.description}\n`);
      }
    }
  },
};

registerCommand(helpCommand);
