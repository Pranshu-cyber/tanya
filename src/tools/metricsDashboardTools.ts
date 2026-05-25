import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveInsideWorkspace } from "../safety/workspace";
import type { TanyaTool } from "./types";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asOptionalArray(input: unknown, key: string): unknown[] {
  const value = asRecord(input)[key];
  return Array.isArray(value) ? value : [];
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const recordMetricsDashboardHandoffTool: TanyaTool = {
  name: "record_metrics_dashboard_handoff",
  description: "Record a structured handoff after app analytics events are implemented so an external dashboard system can regenerate/provision dashboards next.",
  definition: {
    type: "function",
    function: {
      name: "record_metrics_dashboard_handoff",
      description: "Write a structured metrics-dashboard handoff file after implementing app analytics tracking events. This does not provision external dashboards.",
      parameters: {
        type: "object",
        properties: {
          appName: { type: "string", description: "App name, for example DemoApp." },
          implementedEvents: {
            type: "array",
            description: "Implemented tracking events with emit-site details.",
            items: {
              type: "object",
              properties: {
                event: { type: "string" },
                platform: { type: "string" },
                emitSite: { type: "string" },
                file: { type: "string" },
                properties: { type: "array", items: { type: "string" } },
              },
              required: ["event", "emitSite"],
              additionalProperties: true,
            },
          },
          unresolvedGaps: {
            type: "array",
            description: "Requested events that could not be implemented.",
            items: { type: "object", additionalProperties: true },
          },
          changedFiles: { type: "array", items: { type: "string" } },
          verification: {
            type: "array",
            description: "Verification commands and results.",
            items: {
              type: "object",
              properties: {
                command: { type: "string" },
                result: { type: "string" },
              },
              required: ["command", "result"],
              additionalProperties: true,
            },
          },
          nextStep: { type: "string", description: "What the dashboard owner should do after this app-code run." },
          outputPath: { type: "string", description: "Optional workspace-relative output path. Default .tanya/metrics-dashboard-handoff.json." },
        },
        required: ["appName", "implementedEvents", "changedFiles", "verification"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const outputPath = asOptionalString(input, "outputPath") ?? ".tanya/metrics-dashboard-handoff.json";
    const abs = resolveInsideWorkspace(context.workspace, outputPath);
    const payload = {
      appName: asOptionalString(input, "appName") ?? "unknown",
      implementedEvents: asOptionalArray(input, "implementedEvents"),
      unresolvedGaps: asOptionalArray(input, "unresolvedGaps"),
      changedFiles: asOptionalArray(input, "changedFiles"),
      verification: asOptionalArray(input, "verification"),
      nextStep: asOptionalString(input, "nextStep") ?? "Regenerate and provision the metrics dashboard from the updated app instrumentation.",
      createdAt: new Date().toISOString(),
    };

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return {
      ok: true,
      summary: `Recorded metrics dashboard handoff at ${outputPath}.`,
      output: {
        path: outputPath,
        implementedEventCount: payload.implementedEvents.length,
        unresolvedGapCount: payload.unresolvedGaps.length,
        nextStep: payload.nextStep,
      },
      files: [outputPath],
    };
  },
};
