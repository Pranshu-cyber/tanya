import React from "react";
import { Text } from "ink";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ startedAt, now }: { startedAt: number; now: number }) {
  const elapsedMs = Math.max(0, now - startedAt);
  const frameIndex = Math.floor(elapsedMs / 120) % frames.length;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return <Text color="cyan">{frames[frameIndex]} thinking… ({elapsedSec}s)</Text>;
}
