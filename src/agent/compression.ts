import type { ChatMessage, ChatProvider } from "../providers/types";

export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

export async function summarizeOldMessages(
  provider: ChatProvider,
  messages: ChatMessage[],
): Promise<ChatMessage> {
  const text = messages
    .map((message) => {
      const role = message.role.toUpperCase();
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      return `[${role}]: ${content.slice(0, 800)}`;
    })
    .join("\n\n");

  try {
    let summary = "";
    for await (const delta of provider.streamChat({
      messages: [
        {
          role: "user",
          content: `Summarize these agent turns into a compact factual block (max 400 words).
Include: what files were read, what edits were made, what commands ran and their outcomes, any blockers hit.
Do not include reasoning or explanations — only facts.

${text}`,
        },
      ],
      tools: [],
      temperature: 0,
      maxTokens: 512,
    })) {
      if (delta.content) summary += delta.content;
    }

    return {
      role: "user",
      content: `[CONTEXT SUMMARY — earlier turns compressed to save context]\n${summary.trim()}\n[END SUMMARY — continuing task below]`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tanya] Context summarization failed; dropping ${messages.length} older turns without summarization: ${message}`);
    return {
      role: "user",
      content: `[CONTEXT SUMMARY — earlier turns dropped to save context]\nDropped ${messages.length} older turns because summarization failed: ${message}\n[END SUMMARY — continuing task below]`,
    };
  }
}
