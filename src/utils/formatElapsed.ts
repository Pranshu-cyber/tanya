export function formatElapsed(elapsedMs: number): string {
  const ms = Math.max(0, Math.floor(elapsedMs));
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

export function formatClock(date: Date): string {
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((part) => part.toString().padStart(2, "0")).join(":");
}
