import type { ChatProvider } from "../providers/types";

const PLAN_SYSTEM = [
  "You are a senior engineer producing a concise execution plan for a coding agent.",
  "Given a task description and a workspace export map, output ONLY a structured plan.",
  "Format:",
  "Files to read first: <comma-separated list>",
  "Files to modify: <comma-separated list>",
  "Key steps:",
  "1. <step>",
  "2. <step>",
  "...",
  "Verification: <command to run>",
  "Do not write any code. Do not explain. Output the plan only.",
].join("\n");

export async function buildExecutionPlan(
  reasonerProvider: ChatProvider,
  task: string,
  exportMap: string,
): Promise<string> {
  const userContent = exportMap
    ? `Workspace export map:\n${exportMap}\n\nTask: ${task}`
    : `Task: ${task}`;

  let plan = "";
  for await (const delta of reasonerProvider.streamChat({
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: userContent },
    ],
    tools: [],
    temperature: 0,
    maxTokens: 512,
  })) {
    if (delta.content) plan += delta.content;
  }
  return plan.trim();
}
