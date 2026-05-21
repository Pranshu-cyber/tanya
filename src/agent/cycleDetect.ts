export function isLikelySubtaskCycle(prompt: string, recentPrompts: string[], threshold = 0.85): boolean {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) return false;
  return recentPrompts.slice(-3).some((candidate) => {
    const normalizedCandidate = normalizePrompt(candidate);
    if (!normalizedCandidate) return false;
    if (normalizedCandidate.includes(normalizedPrompt) || normalizedPrompt.includes(normalizedCandidate)) return true;
    return similarity(normalizedPrompt, normalizedCandidate) > threshold;
  });
}

export function similarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(a, b) / maxLength;
}

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}
