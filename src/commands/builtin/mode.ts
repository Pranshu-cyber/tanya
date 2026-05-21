import { writeProjectPermissionMode } from "../../safety/permissions/config";
import type { PermissionMode } from "../../safety/permissions/schema";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const MODES = new Set<PermissionMode>(["default", "ask", "bypass", "plan"]);

const modeCommand: CommandDefinition = {
  name: "mode",
  description: "Switch the project permission mode.",
  category: "built-in",
  handler(args, ctx) {
    const mode = args[0] as PermissionMode | undefined;
    if (!mode || !MODES.has(mode)) {
      ctx.output.write("Usage: /mode <default|ask|bypass|plan>\n");
      return;
    }
    const path = writeProjectPermissionMode(ctx.cwd, mode);
    ctx.output.write(`Permission mode set to ${mode} in ${path}\n`);
  },
};

registerCommand(modeCommand);
