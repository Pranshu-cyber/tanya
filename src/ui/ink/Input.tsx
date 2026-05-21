import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatClock } from "../../utils/formatElapsed";
import { Spinner } from "./Spinner";

const divider = "─".repeat(80);

export function Input({ disabled = false, pendingStartedAt, now, onSubmit, onExit }: {
  disabled?: boolean;
  pendingStartedAt?: number;
  now: number;
  onSubmit?: (value: string) => void;
  onExit?: () => void;
}) {
  const [value, setValue] = useState("");
  const valueRef = useRef("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit?.();
      return;
    }
    if (key.ctrl && input === "d") {
      onExit?.();
      return;
    }
    if (disabled) return;
    const newlineIndex = input.search(/[\r\n]/);
    if (key.return || newlineIndex >= 0) {
      if (newlineIndex > 0) {
        valueRef.current += input.slice(0, newlineIndex);
      }
      const submitted = valueRef.current.trim();
      valueRef.current = "";
      setValue("");
      if (submitted === "/exit" || submitted === "/quit") {
        onExit?.();
        return;
      }
      if (submitted) onSubmit?.(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      valueRef.current = valueRef.current.slice(0, -1);
      setValue(valueRef.current);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      valueRef.current += input;
      setValue(valueRef.current);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Box>
        <Text color="green">[{formatClock(new Date(now))}] &gt; </Text>
        <Text>{disabled ? "" : value}</Text>
        {!disabled ? <Text inverse> </Text> : pendingStartedAt ? <Spinner startedAt={pendingStartedAt} now={now} /> : <Text dimColor>streaming…</Text>}
      </Box>
    </Box>
  );
}
