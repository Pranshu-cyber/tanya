import type { TanyaRunContext } from "../../context/runContext";

export function combinedTaskText(runContext: TanyaRunContext | undefined, prompt: string): string {
  return [
    prompt,
    runContext?.task?.title,
    runContext?.task?.summary,
    ...(runContext?.instructions ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

export function mentionsAny(text: string, needles: RegExp[]): boolean {
  return needles.some((needle) => needle.test(text));
}
