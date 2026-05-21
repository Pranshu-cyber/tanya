import React from "react";
import { Box, Text, useInput } from "ink";
import type { HostPermissionAnswer, PermissionRequest } from "../../safety/permissions/host";

export function PermissionPrompt({ request, onAnswer }: {
  request: PermissionRequest | null;
  onAnswer: (answer: HostPermissionAnswer) => void;
}) {
  useInput((input) => {
    if (!request) return;
    const normalized = input.trim().toLowerCase();
    if (normalized === "y") onAnswer({ decision: "allow" });
    if (normalized === "n") onAnswer({ decision: "deny" });
  }, { isActive: request !== null });

  if (!request) return null;
  const label = request.matchedRule ? `${request.tool} (${request.matchedRule})` : request.tool;
  const question = request.input && typeof request.input === "object" && typeof (request.input as { question?: unknown }).question === "string"
    ? (request.input as { question: string }).question
    : undefined;
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow">{question ?? `Permission required for ${label}.`} Press y to allow, n to deny.</Text>
    </Box>
  );
}
