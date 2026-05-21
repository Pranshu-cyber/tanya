import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import type { TanyaTool } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing string field: ${key}`);
  return value;
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ensureRelativePath(path: string): string {
  if (path.startsWith("/")) throw new Error(`Path must be relative to the workspace: ${path}`);
  return path;
}

function optionalStringArray(input: unknown, key: string, fallback: string[]): string[] {
  const value = asRecord(input)[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-z0-9@._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

type AppleIconSlot = {
  idiom: string;
  size: string;
  scale: "1x" | "2x" | "3x";
};

const iosIconSlots: AppleIconSlot[] = [
  { idiom: "iphone", size: "20x20", scale: "2x" },
  { idiom: "iphone", size: "20x20", scale: "3x" },
  { idiom: "iphone", size: "29x29", scale: "2x" },
  { idiom: "iphone", size: "29x29", scale: "3x" },
  { idiom: "iphone", size: "40x40", scale: "2x" },
  { idiom: "iphone", size: "40x40", scale: "3x" },
  { idiom: "iphone", size: "60x60", scale: "2x" },
  { idiom: "iphone", size: "60x60", scale: "3x" },
  { idiom: "ipad", size: "20x20", scale: "1x" },
  { idiom: "ipad", size: "20x20", scale: "2x" },
  { idiom: "ipad", size: "29x29", scale: "1x" },
  { idiom: "ipad", size: "29x29", scale: "2x" },
  { idiom: "ipad", size: "40x40", scale: "1x" },
  { idiom: "ipad", size: "40x40", scale: "2x" },
  { idiom: "ipad", size: "76x76", scale: "1x" },
  { idiom: "ipad", size: "76x76", scale: "2x" },
  { idiom: "ipad", size: "83.5x83.5", scale: "2x" },
  { idiom: "ios-marketing", size: "1024x1024", scale: "1x" },
];

const macIconSlots: AppleIconSlot[] = [
  { idiom: "mac", size: "16x16", scale: "1x" },
  { idiom: "mac", size: "16x16", scale: "2x" },
  { idiom: "mac", size: "32x32", scale: "1x" },
  { idiom: "mac", size: "32x32", scale: "2x" },
  { idiom: "mac", size: "128x128", scale: "1x" },
  { idiom: "mac", size: "128x128", scale: "2x" },
  { idiom: "mac", size: "256x256", scale: "1x" },
  { idiom: "mac", size: "256x256", scale: "2x" },
  { idiom: "mac", size: "512x512", scale: "1x" },
  { idiom: "mac", size: "512x512", scale: "2x" },
];

function pixelSize(slot: AppleIconSlot): number {
  const points = Number.parseFloat(slot.size.split("x")[0] ?? "0");
  const scale = Number.parseInt(slot.scale, 10);
  return Math.round(points * scale);
}

function slotsForPlatforms(platforms: string[]): AppleIconSlot[] {
  const normalized = new Set(platforms.map((platform) => platform.toLowerCase()));
  const slots: AppleIconSlot[] = [];
  if (normalized.has("ios") || normalized.has("iphone") || normalized.has("ipad")) slots.push(...iosIconSlots);
  if (normalized.has("macos") || normalized.has("mac")) slots.push(...macIconSlots);
  return slots;
}

async function resizePng(params: {
  sourceAbs: string;
  destinationAbs: string;
  width: number;
  height: number;
  background: string;
}) {
  await mkdir(dirname(params.destinationAbs), { recursive: true });
  await sharp(params.sourceAbs)
    .resize(params.width, params.height, { fit: "cover", position: "center" })
    .flatten({ background: params.background })
    .png({ force: true })
    .toFile(params.destinationAbs);
}

export const resizeImageTool: TanyaTool = {
  name: "resize_image",
  description: "Resize an image to a PNG inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "resize_image",
      description: "Resize an image to a PNG inside the workspace. Useful for icons, splash assets, and app resources.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source image path relative to the workspace." },
          destination: { type: "string", description: "Destination PNG path relative to the workspace." },
          width: { type: "number", description: "Output width in pixels." },
          height: { type: "number", description: "Output height in pixels. Defaults to width." },
          background: { type: "string", description: "Background color used to remove alpha. Default #ffffff." },
        },
        required: ["source", "destination", "width"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const width = Math.round(asOptionalNumber(input, "width", 0));
    const height = Math.round(asOptionalNumber(input, "height", width));
    const background = asOptionalString(input, "background") ?? "#ffffff";
    if (width <= 0 || height <= 0) return { ok: false, summary: "Invalid image dimensions.", error: "width and height must be positive." };

    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await resizePng({ sourceAbs, destinationAbs, width, height, background });
    return {
      ok: true,
      summary: `Resized ${source} to ${width}x${height}.`,
      output: { source, destination, width, height },
      files: [destination],
    };
  },
};

export const renderSvgToPngTool: TanyaTool = {
  name: "render_svg_to_png",
  description: "Render an SVG file to a PNG inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "render_svg_to_png",
      description: "Render an SVG file to a PNG inside the workspace. Useful for creating a source icon PNG from a generated vector design.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source SVG path relative to the workspace." },
          destination: { type: "string", description: "Destination PNG path relative to the workspace." },
          width: { type: "number", description: "Output width in pixels. Default 1024." },
          height: { type: "number", description: "Output height in pixels. Defaults to width." },
          background: { type: "string", description: "Background color used to remove alpha. Default #ffffff." },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const width = Math.round(asOptionalNumber(input, "width", 1024));
    const height = Math.round(asOptionalNumber(input, "height", width));
    const background = asOptionalString(input, "background") ?? "#ffffff";
    if (width <= 0 || height <= 0) return { ok: false, summary: "Invalid image dimensions.", error: "width and height must be positive." };

    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await mkdir(dirname(destinationAbs), { recursive: true });
    const svg = await readFile(sourceAbs);
    await sharp(svg, { density: 384 })
      .resize(width, height, { fit: "cover", position: "center" })
      .flatten({ background })
      .png({ force: true })
      .toFile(destinationAbs);
    return {
      ok: true,
      summary: `Rendered ${source} to ${width}x${height} PNG.`,
      output: { source, destination, width, height },
      files: [destination],
    };
  },
};

export const createAppleAppIconSetTool: TanyaTool = {
  name: "create_apple_app_icon_set",
  description: "Generate an Apple AppIcon.appiconset from a source image.",
  definition: {
    type: "function",
    function: {
      name: "create_apple_app_icon_set",
      description: "Generate PNG sizes and Contents.json for an Apple AppIcon.appiconset. Supports iOS and macOS.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source image path relative to the workspace. Prefer a 1024x1024 PNG." },
          outputDir: { type: "string", description: "Destination .appiconset directory relative to the workspace." },
          platforms: {
            type: "array",
            items: { type: "string", enum: ["ios", "macos"] },
            description: "Platforms to generate. Default ['ios'].",
          },
          background: { type: "string", description: "Background color used to remove alpha. Default #ffffff." },
        },
        required: ["source", "outputDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const outputDir = ensureRelativePath(asString(input, "outputDir"));
    const platforms = optionalStringArray(input, "platforms", ["ios"]);
    const slots = slotsForPlatforms(platforms);
    const background = asOptionalString(input, "background") ?? "#ffffff";
    if (slots.length === 0) {
      return { ok: false, summary: "No Apple icon platforms selected.", error: "Use platforms ['ios'], ['macos'], or both." };
    }

    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const outputAbs = resolveInsideWorkspace(context.workspace, outputDir);
    await mkdir(outputAbs, { recursive: true });

    const generatedFiles: string[] = [];
    const images = [];
    for (const slot of slots) {
      const px = pixelSize(slot);
      const filename = `AppIcon-${sanitizeName(slot.idiom)}-${sanitizeName(slot.size)}@${slot.scale}.png`;
      const destination = `${outputDir}/${filename}`;
      const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
      await resizePng({ sourceAbs, destinationAbs, width: px, height: px, background });
      generatedFiles.push(destination);
      images.push({
        idiom: slot.idiom,
        size: slot.size,
        scale: slot.scale,
        filename,
      });
    }

    const contentsPath = `${outputDir}/Contents.json`;
    const contents = {
      images,
      info: {
        author: "xcode",
        version: 1,
      },
    };
    await writeFile(resolveInsideWorkspace(context.workspace, contentsPath), `${JSON.stringify(contents, null, 2)}\n`, "utf8");
    generatedFiles.push(contentsPath);

    return {
      ok: true,
      summary: `Generated ${images.length} Apple app icon image${images.length === 1 ? "" : "s"}.`,
      output: { source, outputDir, platforms, images: images.length, contentsPath },
      files: generatedFiles,
    };
  },
};

const androidLauncherDensities = [
  { dir: "mipmap-mdpi", icon: 48, foreground: 108 },
  { dir: "mipmap-hdpi", icon: 72, foreground: 162 },
  { dir: "mipmap-xhdpi", icon: 96, foreground: 216 },
  { dir: "mipmap-xxhdpi", icon: 144, foreground: 324 },
  { dir: "mipmap-xxxhdpi", icon: 192, foreground: 432 },
] as const;

export const createAndroidLauncherIconSetTool: TanyaTool = {
  name: "create_android_launcher_icon_set",
  description: "Generate Android launcher and adaptive icon resources from a source image.",
  definition: {
    type: "function",
    function: {
      name: "create_android_launcher_icon_set",
      description: "Generate Android launcher PNGs, round icons, adaptive icon foreground PNGs, and adaptive icon XML resources.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source image path relative to the workspace. Prefer a 1024x1024 PNG." },
          resDir: { type: "string", description: "Android res directory relative to the workspace, for example app/src/main/res." },
          background: { type: "string", description: "Background color for flattened PNGs and adaptive icon background. Default #ffffff." },
          iconName: { type: "string", description: "Launcher icon resource base name. Default ic_launcher." },
          roundIconName: { type: "string", description: "Round launcher icon resource base name. Default ic_launcher_round." },
        },
        required: ["source", "resDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const resDir = ensureRelativePath(asString(input, "resDir"));
    const background = asOptionalString(input, "background") ?? "#ffffff";
    const iconName = sanitizeName(asOptionalString(input, "iconName") ?? "ic_launcher");
    const roundIconName = sanitizeName(asOptionalString(input, "roundIconName") ?? "ic_launcher_round");
    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const generatedFiles: string[] = [];

    for (const density of androidLauncherDensities) {
      const iconPath = `${resDir}/${density.dir}/${iconName}.png`;
      await resizePng({
        sourceAbs,
        destinationAbs: resolveInsideWorkspace(context.workspace, iconPath),
        width: density.icon,
        height: density.icon,
        background,
      });
      generatedFiles.push(iconPath);

      const roundIconPath = `${resDir}/${density.dir}/${roundIconName}.png`;
      await resizePng({
        sourceAbs,
        destinationAbs: resolveInsideWorkspace(context.workspace, roundIconPath),
        width: density.icon,
        height: density.icon,
        background,
      });
      generatedFiles.push(roundIconPath);

      const foregroundPath = `${resDir}/${density.dir}/${iconName}_foreground.png`;
      await resizePng({
        sourceAbs,
        destinationAbs: resolveInsideWorkspace(context.workspace, foregroundPath),
        width: density.foreground,
        height: density.foreground,
        background: "transparent",
      });
      generatedFiles.push(foregroundPath);
    }

    const backgroundPath = `${resDir}/drawable/${iconName}_background.xml`;
    await mkdir(dirname(resolveInsideWorkspace(context.workspace, backgroundPath)), { recursive: true });
    await writeFile(
      resolveInsideWorkspace(context.workspace, backgroundPath),
      `<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n  <solid android:color="${background}" />\n</shape>\n`,
      "utf8",
    );
    generatedFiles.push(backgroundPath);

    const adaptiveDir = `${resDir}/mipmap-anydpi-v26`;
    for (const name of [iconName, roundIconName]) {
      const adaptivePath = `${adaptiveDir}/${name}.xml`;
      await mkdir(dirname(resolveInsideWorkspace(context.workspace, adaptivePath)), { recursive: true });
      await writeFile(
        resolveInsideWorkspace(context.workspace, adaptivePath),
        `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@drawable/${iconName}_background" />\n  <foreground android:drawable="@mipmap/${iconName}_foreground" />\n</adaptive-icon>\n`,
        "utf8",
      );
      generatedFiles.push(adaptivePath);
    }

    const playIconPath = `${resDir}/play-store-icon.png`;
    await resizePng({
      sourceAbs,
      destinationAbs: resolveInsideWorkspace(context.workspace, playIconPath),
      width: 512,
      height: 512,
      background,
    });
    generatedFiles.push(playIconPath);

    return {
      ok: true,
      summary: `Generated Android launcher icon resources in ${resDir}.`,
      output: { source, resDir, iconName, roundIconName, densities: androidLauncherDensities.length, files: generatedFiles.length },
      files: generatedFiles,
    };
  },
};

export const validateAppleAppIconSetTool: TanyaTool = {
  name: "validate_apple_app_icon_set",
  description: "Validate an Apple AppIcon.appiconset Contents.json, referenced PNGs, dimensions, and alpha.",
  definition: {
    type: "function",
    function: {
      name: "validate_apple_app_icon_set",
      description: "Validate an Apple AppIcon.appiconset. Supports iOS and macOS slot expectations.",
      parameters: {
        type: "object",
        properties: {
          appIconSetDir: { type: "string", description: "AppIcon.appiconset directory relative to the workspace." },
          platforms: {
            type: "array",
            items: { type: "string", enum: ["ios", "macos"] },
            description: "Platforms expected. Default ['ios'].",
          },
          requireNoAlpha: { type: "boolean", description: "Fail if generated PNGs contain alpha. Default true." },
        },
        required: ["appIconSetDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const appIconSetDir = ensureRelativePath(asString(input, "appIconSetDir"));
    const platforms = optionalStringArray(input, "platforms", ["ios"]);
    const requireNoAlpha = asRecord(input).requireNoAlpha !== false;
    const expectedSlots = slotsForPlatforms(platforms);
    const contentsPath = `${appIconSetDir}/Contents.json`;
    const contentsText = await readFile(resolveInsideWorkspace(context.workspace, contentsPath), "utf8");
    const contents = JSON.parse(contentsText) as { images?: Array<{ idiom?: string; size?: string; scale?: string; filename?: string }> };
    const images = Array.isArray(contents.images) ? contents.images : [];
    const problems: string[] = [];

    for (const expected of expectedSlots) {
      const entry = images.find((image) => image.idiom === expected.idiom && image.size === expected.size && image.scale === expected.scale);
      if (!entry?.filename) {
        problems.push(`Missing ${expected.idiom} ${expected.size}@${expected.scale}`);
        continue;
      }
      const metadata = await sharp(resolveInsideWorkspace(context.workspace, `${appIconSetDir}/${entry.filename}`)).metadata();
      const px = pixelSize(expected);
      if (metadata.width !== px || metadata.height !== px) {
        problems.push(`${entry.filename} expected ${px}x${px}, got ${metadata.width}x${metadata.height}`);
      }
      if (requireNoAlpha && metadata.hasAlpha) {
        problems.push(`${entry.filename} contains alpha`);
      }
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0
        ? `Validated ${expectedSlots.length} Apple app icon slot${expectedSlots.length === 1 ? "" : "s"}.`
        : `Apple app icon validation found ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { appIconSetDir, expectedSlots: expectedSlots.length, imageEntries: images.length, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validateAndroidLauncherIconSetTool: TanyaTool = {
  name: "validate_android_launcher_icon_set",
  description: "Validate Android launcher PNGs and adaptive icon XML resources.",
  definition: {
    type: "function",
    function: {
      name: "validate_android_launcher_icon_set",
      description: "Validate Android launcher PNG densities, adaptive icon XML resources, and Play Store icon.",
      parameters: {
        type: "object",
        properties: {
          resDir: { type: "string", description: "Android res directory relative to the workspace, for example app/src/main/res." },
          iconName: { type: "string", description: "Launcher icon resource base name. Default ic_launcher." },
          roundIconName: { type: "string", description: "Round launcher icon resource base name. Default ic_launcher_round." },
        },
        required: ["resDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const resDir = ensureRelativePath(asString(input, "resDir"));
    const iconName = sanitizeName(asOptionalString(input, "iconName") ?? "ic_launcher");
    const roundIconName = sanitizeName(asOptionalString(input, "roundIconName") ?? "ic_launcher_round");
    const problems: string[] = [];

    for (const density of androidLauncherDensities) {
      for (const [fileName, expectedPx] of [
        [`${iconName}.png`, density.icon],
        [`${roundIconName}.png`, density.icon],
        [`${iconName}_foreground.png`, density.foreground],
      ] as const) {
        const resourcePath = `${resDir}/${density.dir}/${fileName}`;
        try {
          const metadata = await sharp(resolveInsideWorkspace(context.workspace, resourcePath)).metadata();
          if (metadata.width !== expectedPx || metadata.height !== expectedPx) {
            problems.push(`${resourcePath} expected ${expectedPx}x${expectedPx}, got ${metadata.width}x${metadata.height}`);
          }
        } catch {
          problems.push(`Missing ${resourcePath}`);
        }
      }
    }

    for (const xmlPath of [
      `${resDir}/drawable/${iconName}_background.xml`,
      `${resDir}/mipmap-anydpi-v26/${iconName}.xml`,
      `${resDir}/mipmap-anydpi-v26/${roundIconName}.xml`,
    ]) {
      try {
        await readFile(resolveInsideWorkspace(context.workspace, xmlPath), "utf8");
      } catch {
        problems.push(`Missing ${xmlPath}`);
      }
    }

    try {
      const metadata = await sharp(resolveInsideWorkspace(context.workspace, `${resDir}/play-store-icon.png`)).metadata();
      if (metadata.width !== 512 || metadata.height !== 512) problems.push("play-store-icon.png must be 512x512");
    } catch {
      problems.push(`Missing ${resDir}/play-store-icon.png`);
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0
        ? "Validated Android launcher icon resources."
        : `Android launcher icon validation found ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { resDir, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};
