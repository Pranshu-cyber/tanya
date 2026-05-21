import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderFullAd, type FullAdRenderSpec } from "../src/tools/adRenderTools";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tanya-ad-render-"));
}

describe("full ad renderer", () => {
  it("renders a short vertical poster from a 2-scene spec", async () => {
    const root = makeWorkspace();
    await sharp({
      create: {
        width: 360,
        height: 640,
        channels: 4,
        background: "#2563eb",
      },
    }).png().toFile(join(root, "asset.png"));

    const spec: FullAdRenderSpec = {
      version: 1,
      canvas: {
        width: 1080,
        height: 1920,
        fps: 2,
        safeArea: { x: 120, y: 220, width: 810, height: 1340 },
      },
      assets: [
        {
          id: "asset-1",
          type: "image",
          mimeType: "image/png",
          src: "asset.png",
          width: 360,
          height: 640,
          durationMs: null,
        },
      ],
      scenes: [
        {
          id: "scene-1",
          order: 0,
          durationMs: 500,
          backgroundPreset: "gradient-dark",
          transition: "cut",
          layers: [
            {
              id: "scene-1:title",
              type: "text",
              text: "Ship the proof",
              role: "title",
              color: "#ffffff",
              fontSize: 68,
              fontWeight: 780,
              align: "center",
              x: 120,
              y: 220,
              width: 840,
              height: 160,
              zIndex: 10,
              startTimeMs: 0,
              endTimeMs: null,
              opacity: 1,
              animation: "scale-in",
            },
            {
              id: "scene-1:asset",
              type: "image",
              assetId: "asset-1",
              fit: "cover",
              borderRadius: 32,
              shadow: true,
              x: 180,
              y: 520,
              width: 720,
              height: 900,
              zIndex: 1,
              startTimeMs: 0,
              endTimeMs: null,
              opacity: 1,
              animation: "fade-in",
            },
          ],
        },
        {
          id: "scene-2",
          order: 1,
          durationMs: 500,
          backgroundPreset: "solid-light",
          transition: "slide-up",
          layers: [
            {
              id: "scene-2:title",
              type: "text",
              text: "Ready for review",
              role: "title",
              color: "#151720",
              fontSize: 64,
              fontWeight: 760,
              align: "center",
              x: 120,
              y: 760,
              width: 840,
              height: 180,
              zIndex: 10,
              startTimeMs: 0,
              endTimeMs: null,
              opacity: 1,
              animation: "fade-up",
            },
          ],
        },
      ],
    };
    writeFileSync(join(root, "spec.json"), JSON.stringify(spec));

    const result = await renderFullAd(
      { input: "spec.json", outputDir: "renders", basename: "proof", formats: ["poster"] },
      root,
    );

    expect(result.durationMs).toBe(1000);
    expect(result.frameCount).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.posterPath).toBe(join(root, "renders", "proof-poster.png"));
    expect(existsSync(result.posterPath!)).toBe(true);

    const metadata = await sharp(readFileSync(result.posterPath!)).metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(1920);
  });
});
