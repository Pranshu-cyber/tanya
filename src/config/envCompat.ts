export function envValue(local: Record<string, string | undefined> = {}, key: string): string {
  return process.env[key] ?? local[key] ?? "";
}

export function numberEnvValue(local: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = envValue(local, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
