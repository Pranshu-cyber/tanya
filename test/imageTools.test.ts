import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createAndroidLauncherIconSetTool,
  createAppleAppIconSetTool,
  renderSvgToPngTool,
  resizeImageTool,
  validateAndroidLauncherIconSetTool,
  validateAppleAppIconSetTool,
} from "../src/tools/imageTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-image-tools-"));
}

describe("image tools", () => {
  it("renders an SVG to PNG and resizes it", async () => {
    const root = makeProject();
    writeFileSync(
      join(root, "icon.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        <rect width="1024" height="1024" fill="#0f766e"/>
        <path d="M256 640 L512 192 L768 640 Z" fill="#ffffff"/>
      </svg>`,
    );

    const renderResult = await renderSvgToPngTool.run(
      { source: "icon.svg", destination: "icon-1024.png", width: 1024, height: 1024 },
      { workspace: root },
    );
    const resizeResult = await resizeImageTool.run(
      { source: "icon-1024.png", destination: "icon-60.png", width: 60 },
      { workspace: root },
    );

    expect(renderResult.ok).toBe(true);
    expect(resizeResult.ok).toBe(true);
    expect(statSync(join(root, "icon-1024.png")).size).toBeGreaterThan(1000);
    const metadata = await sharp(join(root, "icon-60.png")).metadata();
    expect(metadata.width).toBe(60);
    expect(metadata.height).toBe(60);
  });

  it("creates an Apple app icon set with Contents.json", async () => {
    const root = makeProject();
    await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: "#2563eb",
      },
    }).png().toFile(join(root, "source.png"));

    const result = await createAppleAppIconSetTool.run(
      {
        source: "source.png",
        outputDir: "Assets.xcassets/AppIcon.appiconset",
        platforms: ["ios", "macos"],
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "Assets.xcassets", "AppIcon.appiconset", "Contents.json"))).toBe(true);
    expect(existsSync(join(root, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-ios-marketing-1024x1024@1x.png"))).toBe(true);
    expect(existsSync(join(root, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-mac-512x512@2x.png"))).toBe(true);

    const contents = JSON.parse(readFileSync(join(root, "Assets.xcassets", "AppIcon.appiconset", "Contents.json"), "utf8"));
    expect(contents.images).toHaveLength(28);
    expect(contents.images.some((image: { idiom: string }) => image.idiom === "ios-marketing")).toBe(true);
    expect(contents.images.some((image: { idiom: string }) => image.idiom === "mac")).toBe(true);

    const validation = await validateAppleAppIconSetTool.run(
      { appIconSetDir: "Assets.xcassets/AppIcon.appiconset", platforms: ["ios", "macos"] },
      { workspace: root },
    );
    expect(validation.ok).toBe(true);
  });

  it("creates Android launcher and adaptive icon resources", async () => {
    const root = makeProject();
    await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: "#111827",
      },
    }).png().toFile(join(root, "source.png"));

    const result = await createAndroidLauncherIconSetTool.run(
      {
        source: "source.png",
        resDir: "app/src/main/res",
        background: "#111827",
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "app/src/main/res/mipmap-mdpi/ic_launcher.png"))).toBe(true);
    expect(existsSync(join(root, "app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png"))).toBe(true);
    expect(existsSync(join(root, "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"))).toBe(true);
    expect(existsSync(join(root, "app/src/main/res/drawable/ic_launcher_background.xml"))).toBe(true);
    expect(existsSync(join(root, "app/src/main/res/play-store-icon.png"))).toBe(true);

    const metadata = await sharp(join(root, "app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")).metadata();
    expect(metadata.width).toBe(192);
    expect(metadata.height).toBe(192);

    const validation = await validateAndroidLauncherIconSetTool.run(
      { resDir: "app/src/main/res" },
      { workspace: root },
    );
    expect(validation.ok).toBe(true);
  });
});
