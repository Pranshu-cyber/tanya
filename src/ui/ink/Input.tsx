import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatClock } from "../../utils/formatElapsed";

function InputView({ disabled = false, pendingStartedAt, now, onSubmit, onExit }: {
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

  const borderColor = disabled ? "gray" : "cyan";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1}>
      <Box>
        <Text color={disabled ? "gray" : "green"}>[{formatClock(new Date(now))}] &gt; </Text>
        {disabled ? (
          pendingStartedAt ? <Text dimColor>…</Text> : <Text dimColor>streaming…</Text>
        ) : (
          <>
            <Text>{value}</Text>
            <Text inverse> </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

// Memoized so token/activity-driven App re-renders don't repaint the input row;
// with stable onSubmit/onExit refs from App it re-renders only when its own props
// change — the once-per-second clock (now), disabled, or pendingStartedAt.
export const Input = React.memo(InputView);
