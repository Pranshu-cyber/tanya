import type { ChatProvider } from "../providers/types";

const REVIEW_SYSTEM = [
  "You are a senior code reviewer. You will be given a task description and the diff of changes made.",
  "Review only what was changed. Be concise. Flag only real issues.",
  "Output format:",
  "## Review",
  "**Verdict:** LGTM | NEEDS CHANGES",
  "",
  "**Issues:** (list only if verdict is NEEDS CHANGES)",
  "- <file>:<line> — <issue>",
  "",
  "**Suggestions:** (optional minor improvements, max 3)",
  "- <suggestion>",
  "",
  "Do not praise the code. Do not explain what the code does. Only flag problems.",
].join("\n");

export async function reviewChanges(
  provider: ChatProvider,
  task: string,
  diff: string,
): Promise<string> {
  if (!diff.trim()) return "## Review\n**Verdict:** LGTM\n\nNo changes to review.";

  let review = "";
  for await (const delta of provider.streamChat({
    messages: [
      { role: "system", content: REVIEW_SYSTEM },
      {
        role: "user",
        content: `Task: ${task}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
      },
    ],
    tools: [],
    temperature: 0,
    maxTokens: 600,
  })) {
    if (delta.content) review += delta.content;
  }
  return review.trim();
}
