import React from "react";
import { Box, Text } from "ink";

type InlineNode = string | React.ReactElement;

function hasBalancedMarkers(line: string, marker: string): boolean {
  return line.split(marker).length % 2 === 1;
}

function renderInline(line: string): InlineNode[] {
  if (
    (line.includes("**") && !hasBalancedMarkers(line, "**")) ||
    (line.includes("`") && !hasBalancedMarkers(line, "`")) ||
    (line.includes("*") && !line.includes("**") && !hasBalancedMarkers(line, "*")) ||
    (line.includes("_") && !hasBalancedMarkers(line, "_"))
  ) {
    return [line];
  }

  const nodes: InlineNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index));
    const token = match[0]!;
    if (token.startsWith("**")) {
      nodes.push(<Text key={`b-${key++}`} bold>{token.slice(2, -2)}</Text>);
    } else if (token.startsWith("`")) {
      nodes.push(<Text key={`c-${key++}`} inverse>{token.slice(1, -1)}</Text>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <React.Fragment key={`l-${key++}`}>
            <Text underline>{linkMatch[1]}</Text>
            <Text dimColor> ({linkMatch[2]})</Text>
          </React.Fragment>,
        );
      }
    } else {
      nodes.push(<Text key={`i-${key++}`} italic>{token.slice(1, -1)}</Text>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}

function renderFormattedLine(line: string, key: string): React.ReactElement {
  if (/^#{1,3}\s/.test(line)) {
    const [, hashes = "", text = ""] = line.match(/^(#{1,3})\s+(.*)$/) ?? [];
    return <Text key={key} bold color={hashes.length === 1 ? "cyan" : "blue"}>{renderInline(text)}</Text>;
  }
  if (/^\s*[-*]\s+/.test(line)) {
    return <Text key={key}>• {renderInline(line.replace(/^\s*[-*]\s+/, ""))}</Text>;
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    const marker = line.match(/^\s*(\d+\.)\s+/)?.[1] ?? "1.";
    return <Text key={key}>{marker} {renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</Text>;
  }
  if (/^\s*>\s?/.test(line)) {
    return <Text key={key} dimColor italic>│ {renderInline(line.replace(/^\s*>\s?/, ""))}</Text>;
  }
  return <Text key={key}>{renderInline(line)}</Text>;
}

export function MarkdownText({ source, formatPartialLine = false }: { source: string; formatPartialLine?: boolean }) {
  if (!source) return null;

  const lines = source.split("\n");
  const hasTrailingNewline = source.endsWith("\n");
  const completeLineCount = lines.length - 1;
  const nodes: React.ReactElement[] = [];
  let index = 0;

  while (index < completeLineCount) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const closingIndex = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.startsWith("```"));
      if (closingIndex > index && closingIndex < lines.length) {
        const code = lines.slice(index + 1, closingIndex).join("\n");
        nodes.push(
          <Box key={`code-${index}`} borderStyle="round" paddingX={1} flexDirection="column">
            <Text>{code}</Text>
          </Box>,
        );
        index = closingIndex + 1;
        continue;
      }
    }
    nodes.push(renderFormattedLine(line, `line-${index}`));
    index += 1;
  }

  if (!hasTrailingNewline) {
    const partial = lines.at(-1) ?? "";
    if (partial) {
      nodes.push(formatPartialLine
        ? renderFormattedLine(partial, "partial")
        : <Text key="partial">{partial}</Text>);
    }
  }

  return <Box flexDirection="column">{nodes}</Box>;
}
