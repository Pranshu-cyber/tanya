import React, { useEffect, useState } from "react";
import { Text } from "ink";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ startedAt }: { startedAt: number }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 120);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(0, tick - startedAt);
  const frameIndex = Math.floor(elapsedMs / 120) % frames.length;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return <Text color="cyan">{frames[frameIndex]} thinking… ({elapsedSec}s)</Text>;
}
