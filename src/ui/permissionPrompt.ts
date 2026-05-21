import type { PermissionRequestHandler } from "../safety/permissions/host";
import { appendLearnedPermissionRule } from "../safety/permissions/learning";

type Question = (prompt: string) => Promise<string>;

export function createReplPermissionRequestHandler(options: {
  question: Question;
  output?: NodeJS.WritableStream;
  home?: string;
}): PermissionRequestHandler {
  return async (request) => {
    const label = request.matchedRule ? `${request.tool} (${request.matchedRule})` : request.tool;
    const question = requestQuestion(request.input);
    while (true) {
      const prompt = question ? `${question} [y/N]` : `Permission required for ${label}. Allow? [y/n/always/never]`;
      const answer = (await options.question(`\x1b[33m${prompt}\x1b[0m `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return { decision: "allow" };
      if (answer === "n" || answer === "no") return { decision: "deny" };
      if (question && answer === "") return { decision: "deny" };
      if (question) {
        options.output?.write("Please answer y or n.\n");
        continue;
      }
      if (answer === "always") {
        const pattern = appendLearnedPermissionRule({
          tool: request.tool,
          input: request.input,
          persistAs: "always",
          ...(options.home ? { home: options.home } : {}),
        });
        options.output?.write(`Saved allow rule: ${pattern}\n`);
        return { decision: "allow", persistAs: "always" };
      }
      if (answer === "never") {
        const pattern = appendLearnedPermissionRule({
          tool: request.tool,
          input: request.input,
          persistAs: "never",
          ...(options.home ? { home: options.home } : {}),
        });
        options.output?.write(`Saved deny rule: ${pattern}\n`);
        return { decision: "deny", persistAs: "never" };
      }
      options.output?.write("Please answer y, n, always, or never.\n");
    }
  };
}

function requestQuestion(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const question = (input as { question?: unknown }).question;
  return typeof question === "string" && question.trim() ? question : undefined;
}
