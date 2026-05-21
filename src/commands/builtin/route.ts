import { loadRouteTable, resolveRoute, type EffectiveRouteTable, type RouteTarget, type StepType } from "../../router";
import { registerCommand } from "../registry";
import type { CommandContext, CommandDefinition } from "../registry";

const STEP_TYPES = new Set<StepType>(["planning", "tool_call", "synthesis", "verification", "reasoning", "unknown"]);

const routeCommand: CommandDefinition = {
  name: "route",
  description: "Show or patch the active model route table.",
  category: "built-in",
  handler(args, ctx) {
    const table = effectiveTable(ctx);
    const subcommand = args[0];
    if (!subcommand) {
      printTable(ctx, table);
      return;
    }

    if (subcommand === "show") {
      const stepType = parseStep(args[1]);
      if (!stepType) {
        ctx.output.write("Usage: /route show <planning|tool_call|synthesis|verification|reasoning|unknown>\n");
        return;
      }
      const route = resolveRoute(stepType, table);
      ctx.output.write(`${stepType}: ${route.provider}/${route.model} (${route.source}; ${route.reason})`);
      if (route.fallback) ctx.output.write(` fallback ${route.fallback.provider}/${route.fallback.model}`);
      ctx.output.write("\n");
      return;
    }

    if (subcommand === "set") {
      const stepType = parseStep(args[1]);
      const target = parseTarget(args[2]);
      if (!stepType || !target) {
        ctx.output.write("Usage: /route set <stepType> <provider>/<model>\n");
        return;
      }
      if (!ctx.routing) {
        ctx.output.write("Route patching requires an active Tanya routing session.\n");
        return;
      }
      ctx.routing.enabled = true;
      ctx.routing.table.routes = [
        { match: stepType, provider: target.provider, model: target.model, source: "session" },
        ...ctx.routing.table.routes.filter((route) => !(route.source === "session" && route.match === stepType)),
      ];
      ctx.output.write(`Route ${stepType} set to ${target.provider}/${target.model} for this session.\n`);
      return;
    }

    if (subcommand === "reset") {
      if (ctx.routing) {
        ctx.routing.table.routes = ctx.routing.table.routes.filter((route) => route.source !== "session");
        ctx.routing.enabled = ctx.routing.table.sources.some((source) => source !== "built-in");
      }
      ctx.output.write("Session route patches cleared.\n");
      return;
    }

    ctx.output.write("Usage: /route [show <stepType>|set <stepType> <provider>/<model>|reset]\n");
  },
};

function effectiveTable(ctx: CommandContext): EffectiveRouteTable {
  if (ctx.routing) return ctx.routing.table;
  const provider = ctx.provider ? { provider: ctx.provider.id, model: ctx.provider.model } : { provider: "openai", model: "gpt-4.1-mini" };
  return loadRouteTable({ cwd: ctx.cwd, defaults: provider }).table;
}

function printTable(ctx: CommandContext, table: EffectiveRouteTable): void {
  ctx.output.write("stepType | provider | model | fallback | source\n");
  ctx.output.write("--- | --- | --- | --- | ---\n");
  for (const route of table.routes) {
    const match = typeof route.match === "string" ? route.match : `/${route.match.regex}/`;
    const fallback = route.fallback ? `${route.fallback.provider}/${route.fallback.model}` : "-";
    ctx.output.write(`${match} | ${route.provider} | ${route.model} | ${fallback} | ${route.source}\n`);
  }
  ctx.output.write(`defaults | ${table.defaults.provider} | ${table.defaults.model} | - | ${table.defaultSource}\n`);
}

function parseStep(value: string | undefined): StepType | null {
  return value && STEP_TYPES.has(value as StepType) ? value as StepType : null;
}

function parseTarget(value: string | undefined): RouteTarget | null {
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

registerCommand(routeCommand);
