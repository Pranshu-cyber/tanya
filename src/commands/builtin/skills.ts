import { loadPromptSkillPacks } from "../../agent/systemPrompt";
import { formatSkillPackSummary } from "../../skills";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const skillsCommand: CommandDefinition = {
  name: "skills",
  description: "Show skill packs matched for this workspace.",
  category: "built-in",
  handler(args, ctx) {
    const taskHint = args.join(" ");
    const packs = loadPromptSkillPacks(ctx.cwd, undefined, taskHint);
    ctx.output.write(`${formatSkillPackSummary(packs)}\n`);
  },
};

registerCommand(skillsCommand);
