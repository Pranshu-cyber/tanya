const warnedLegacyKeys = new Set<string>();

function readRaw(local: Record<string, string | undefined>, key: string): string | undefined {
  return process.env[key] ?? local[key];
}

function legacyKey(key: string): string | null {
  return key.startsWith("TANYA_") ? `TANIA_${key.slice("TANYA_".length)}` : null;
}

function warnLegacyEnv(legacy: string, current: string): void {
  if (warnedLegacyKeys.has(legacy)) return;
  warnedLegacyKeys.add(legacy);
  console.warn(`[tanya] ${legacy} is deprecated; use ${current}.`);
}

export function envValue(local: Record<string, string | undefined> = {}, key: string): string {
  const current = readRaw(local, key);
  if (current !== undefined) return current;

  const legacy = legacyKey(key);
  if (!legacy) return "";

  const legacyValue = readRaw(local, legacy);
  if (legacyValue === undefined) return "";
  warnLegacyEnv(legacy, key);
  return legacyValue;
}

export function numberEnvValue(local: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = envValue(local, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
