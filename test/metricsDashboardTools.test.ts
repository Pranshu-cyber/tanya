import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultTools } from "../src/tools/fsTools";
import { recordMetricsDashboardHandoffTool } from "../src/tools/metricsDashboardTools";

describe("record_metrics_dashboard_handoff", () => {
  it("is exposed through the default Tanya tool registry", () => {
    expect(defaultTools().some((tool) => tool.name === "record_metrics_dashboard_handoff")).toBe(true);
  });

  it("writes a structured handoff inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tanya-metrics-handoff-"));
    const result = await recordMetricsDashboardHandoffTool.run({
      appName: "DemoApp",
      implementedEvents: [
        {
          event: "proxy_tool_opened",
          platform: "macos",
          emitSite: "NetworkProxyView.onAppear",
          file: "DemoApp/Features/Tools/NetworkProxy/NetworkProxyView.swift",
          properties: ["app_id", "environment", "event_category:proxy", "event_level:info"],
        },
      ],
      unresolvedGaps: [],
      changedFiles: ["DemoApp/Core/Observability/ObservabilityEvent.swift"],
      verification: [{ command: "xcodebuild -list", result: "exit 0" }],
    }, { workspace });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([".tanya/metrics-dashboard-handoff.json"]);

    const raw = await readFile(join(workspace, ".tanya/metrics-dashboard-handoff.json"), "utf8");
    const payload = JSON.parse(raw);
    expect(payload.appName).toBe("DemoApp");
    expect(payload.implementedEvents).toHaveLength(1);
    expect(payload.nextStep).toContain("Regenerate and provision");
  });
});
