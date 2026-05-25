import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";
import { envValue } from "../config/envCompat";
import { resolveInsideWorkspace } from "../safety/workspace";

type LayerAnimation = "fade-up" | "type-in" | "scale-in" | "hold" | "fade-in" | "slide-up" | "subtle-parallax";
type SceneTransition = "cut" | "crossfade" | "slide-left" | "slide-up" | "push";

export interface FullAdRenderSpec {
  version: 1;
  canvas: {
    width: number;
    height: number;
    fps: number;
    safeArea?: { x: number; y: number; width: number; height: number };
  };
  project?: { id: string; name: string; appName: string; platform: string };
  brand?: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    iconAssetId?: string;
  };
  assets: Array<{
    id: string;
    type: "image" | "gif" | "video";
    mimeType: string;
    src: string;
    width?: number;
    height?: number;
    durationMs?: number | null;
  }>;
  scenes: FullAdSceneSpec[];
}

export interface FullAdSceneSpec {
  id: string;
  order: number;
  durationMs: number;
  backgroundPreset: string;
  backgroundAssetId?: string;
  layoutPreset?: string;
  transition: SceneTransition;
  layers: FullAdLayerSpec[];
}

export type FullAdLayerSpec = FullAdTextLayerSpec | FullAdMediaLayerSpec;

export interface FullAdBaseLayerSpec {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  startTimeMs: number;
  endTimeMs: number | null;
  opacity: number;
}

export interface FullAdTextLayerSpec extends FullAdBaseLayerSpec {
  type: "text";
  text: string;
  role: "title" | "subtitle" | "caption" | "cta" | "badge";
  color: string;
  fontSize: number;
  fontWeight: number;
  align: "center";
  animation: LayerAnimation;
}

export interface FullAdMediaLayerSpec extends FullAdBaseLayerSpec {
  type: "image" | "video";
  assetId: string;
  fit: "cover" | "contain" | "fill";
  borderRadius: number;
  shadow: boolean;
  animation: LayerAnimation;
}

export interface RenderAdOptions {
  input: string;
  outputDir?: string;
  basename?: string;
  formats?: Array<"mp4" | "poster">;
  ffmpegPath?: string;
}

export interface RenderAdResult {
  mp4Path?: string;
  posterPath?: string;
  durationMs: number;
  frameCount: number;
  width: number;
  height: number;
  warnings: string[];
  renderSpec: FullAdRenderSpec;
}

interface MediaFrames {
  frames: Buffer[];
  fps: number;
}

function findExecutable(name: string, explicit?: string): string {
  if (explicit) return explicit;
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : name;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
}

function easeOut(t: number): number {
  const v = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - v, 3);
}

const SCENE_TRANSITION_DURATION_MS = 560;
const SCENE_TRANSITION_TRAVEL_PX = 52;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function backgroundColor(preset: string): string {
  if (preset === "solid-light") return "#f5f5f7";
  if (preset === "gradient-brand") return "#101628";
  if (preset === "gradient-dark") return "#10111d";
  if (preset === "blur-asset") return "#0a0a0c";
  return "#0a0a0c";
}

function renderBrand(spec: FullAdRenderSpec): Required<NonNullable<FullAdRenderSpec["brand"]>> {
  return {
    primary: spec.brand?.primary ?? "#8C4CEB",
    secondary: spec.brand?.secondary ?? "#6B33CC",
    accent: spec.brand?.accent ?? "#F59E0B",
    background: spec.brand?.background ?? "#080A12",
    iconAssetId: spec.brand?.iconAssetId ?? "",
  };
}

function backgroundSvg(spec: FullAdRenderSpec, scene: FullAdSceneSpec): Buffer {
  const { width, height } = spec.canvas;
  const brand = renderBrand(spec);
  const base = scene.backgroundPreset === "gradient-brand" ? brand.background : backgroundColor(scene.backgroundPreset);
  const brandGlow = scene.backgroundPreset === "gradient-brand" ? brand.primary : "#4f8eff";
  const secondaryGlow = scene.backgroundPreset === "gradient-brand" ? brand.secondary : brandGlow;
  const warmGlow = scene.backgroundPreset === "gradient-brand" ? brand.accent : "#f59e0b";
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g1" cx="28%" cy="12%" r="64%">
        <stop offset="0%" stop-color="${brandGlow}" stop-opacity="0.34"/>
        <stop offset="54%" stop-color="${brandGlow}" stop-opacity="0.08"/>
        <stop offset="100%" stop-color="${base}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="g2" cx="88%" cy="86%" r="54%">
        <stop offset="0%" stop-color="${warmGlow}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${base}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="g3" cx="50%" cy="42%" r="58%">
        <stop offset="0%" stop-color="${secondaryGlow}" stop-opacity="${scene.backgroundPreset === "gradient-brand" ? "0.2" : "0.06"}"/>
        <stop offset="100%" stop-color="${base}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="v" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.04"/>
        <stop offset="46%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.28"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="${base}"/>
    <rect width="100%" height="100%" fill="url(#g1)"/>
    <rect width="100%" height="100%" fill="url(#g2)"/>
    <rect width="100%" height="100%" fill="url(#g3)"/>
    <rect width="100%" height="100%" fill="url(#v)"/>
  </svg>`;
  return Buffer.from(svg);
}

function resolveAssetPath(src: string, workspace: string): string {
  if (src.startsWith("file://")) return new URL(src).pathname;
  if (isAbsolute(src)) return src;
  return resolveInsideWorkspace(workspace, src);
}

async function loadStaticFrame(src: string, workspace: string): Promise<Buffer> {
  if (src.startsWith("data:")) {
    return Buffer.from(src.split(",")[1] ?? "", "base64");
  }
  if (src.startsWith("http://") || src.startsWith("https://")) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Unable to fetch asset ${src}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(resolveAssetPath(src, workspace));
}

async function extractVideoFrames(params: {
  src: string;
  workspace: string;
  outDir: string;
  fps: number;
  ffmpegPath: string;
}): Promise<Buffer[]> {
  await mkdir(params.outDir, { recursive: true });
  const input = resolveAssetPath(params.src, params.workspace);
  run(params.ffmpegPath, [
    "-y",
    "-i",
    input,
    "-vf",
    `fps=${params.fps}`,
    join(params.outDir, "frame-%05d.png"),
  ], params.workspace);
  const files = (await readdir(params.outDir)).filter((file) => file.endsWith(".png")).sort();
  return Promise.all(files.map((file) => readFile(join(params.outDir, file))));
}

async function buildMediaFrames(spec: FullAdRenderSpec, workspace: string, tmpDir: string, ffmpegPath: string, warnings: string[]): Promise<Map<string, MediaFrames>> {
  const media = new Map<string, MediaFrames>();
  for (const asset of spec.assets) {
    try {
      if (asset.type === "video" || asset.type === "gif") {
        const frames = await extractVideoFrames({
          src: asset.src,
          workspace,
          outDir: join(tmpDir, "media", asset.id),
          fps: spec.canvas.fps,
          ffmpegPath,
        });
        media.set(asset.id, { frames: frames.length ? frames : [await sharp(await loadStaticFrame(asset.src, workspace)).png().toBuffer()], fps: spec.canvas.fps });
      } else {
        media.set(asset.id, { frames: [await sharp(await loadStaticFrame(asset.src, workspace)).png().toBuffer()], fps: 1 });
      }
    } catch (error) {
      warnings.push(`Asset ${asset.id} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return media;
}

function wrapText(text: string, maxChars: number, maxLines = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function renderTextSvg(layer: FullAdTextLayerSpec, progress: number, brand?: FullAdRenderSpec["brand"]): Buffer {
  const resolvedBrand = {
    primary: brand?.primary ?? "#8C4CEB",
    secondary: brand?.secondary ?? "#6B33CC",
    accent: brand?.accent ?? "#F59E0B",
  };
  const visibleChars = layer.animation === "type-in"
    ? Math.max(1, Math.ceil(layer.text.length * easeOut(progress)))
    : layer.text.length;
  const text = layer.text.slice(0, visibleChars);
  const maxChars = Math.max(8, Math.floor(layer.width / Math.max(12, layer.fontSize * 0.55)));
  const maxLines = layer.role === "badge" ? 6 : 4;
  const lines = wrapText(text, maxChars, maxLines);
  const fontSize = Math.max(24, Math.min(layer.fontSize, Math.floor(layer.height / Math.max(1.4, lines.length * 1.18))));
  const lineHeight = Math.round(fontSize * 1.16);
  const startY = Math.round((layer.height - lineHeight * lines.length) / 2 + fontSize * 0.88);
  const tspans = lines.map((line, index) =>
    `<tspan x="50%" y="${startY + index * lineHeight}">${escapeXml(line)}</tspan>`,
  ).join("");
  const glowOpacity = layer.role === "title" || layer.role === "cta" ? 0.28 : 0.12;
  const chrome = layer.role === "cta"
    ? `<linearGradient id="ctaFill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${resolvedBrand.primary}"/>
        <stop offset="100%" stop-color="${resolvedBrand.secondary}"/>
      </linearGradient>`
    : layer.role === "badge" || layer.role === "caption"
      ? `<linearGradient id="badgeFill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${resolvedBrand.accent}" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="${resolvedBrand.primary}" stop-opacity="0.14"/>
        </linearGradient>`
      : "";
  const rect = layer.role === "cta"
    ? `<rect x="2" y="2" width="${Math.round(layer.width) - 4}" height="${Math.round(layer.height) - 4}" rx="${Math.round(layer.height / 2)}" fill="url(#ctaFill)" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>`
    : layer.role === "badge" || layer.role === "caption"
      ? `<rect x="2" y="6" width="${Math.round(layer.width) - 4}" height="${Math.round(layer.height) - 12}" rx="${Math.round((layer.height - 12) / 2)}" fill="url(#badgeFill)" stroke="${resolvedBrand.accent}" stroke-opacity="0.34" stroke-width="1.5"/>`
      : "";
  const svg = `<svg width="${Math.round(layer.width)}" height="${Math.round(layer.height)}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      ${chrome}
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity="${glowOpacity}"/>
      </filter>
    </defs>
    ${rect}
    <text text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Inter, Helvetica, Arial, sans-serif"
      font-size="${fontSize}" font-weight="${layer.fontWeight}" fill="${escapeXml(layer.color)}" filter="url(#softShadow)">${tspans}</text>
  </svg>`;
  return Buffer.from(svg);
}

async function roundedMask(width: number, height: number, radius: number): Promise<Buffer> {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${r}" fill="#fff"/></svg>`);
}

async function renderMediaLayer(layer: FullAdMediaLayerSpec, frame: Buffer): Promise<Buffer> {
  const width = Math.max(1, Math.round(layer.width));
  const height = Math.max(1, Math.round(layer.height));
  const resized = sharp(frame)
    .resize(width, height, {
      fit: layer.fit === "contain" ? "inside" : layer.fit === "fill" ? "fill" : "cover",
      position: "center",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha();
  const png = await resized.png().toBuffer();
  if (!layer.borderRadius) return png;
  return sharp(png).composite([{ input: await roundedMask(width, height, layer.borderRadius), blend: "dest-in" }]).png().toBuffer();
}

async function shadowLayer(width: number, height: number, radius: number): Promise<Buffer> {
  const mask = await roundedMask(width, height, radius);
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0.52 },
    },
  })
    .composite([{ input: mask, blend: "dest-in" }])
    .blur(18)
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function scaleOverlay(input: Buffer, scale: number): Promise<{ input: Buffer; dx: number; dy: number }> {
  if (Math.abs(scale - 1) < 0.001) return { input, dx: 0, dy: 0 };
  const meta = await sharp(input).metadata();
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale));
  const height = Math.max(1, Math.round((meta.height ?? 1) * scale));
  return {
    input: await sharp(input).resize(width, height).png().toBuffer(),
    dx: Math.round(((meta.width ?? width) - width) / 2),
    dy: Math.round(((meta.height ?? height) - height) / 2),
  };
}

function layerTransform(layer: FullAdLayerSpec, localMs: number): { opacity: number; dx: number; dy: number; scale: number } {
  const progress = easeOut((localMs - layer.startTimeMs) / 360);
  const baseOpacity = layer.opacity ?? 1;
  if (layer.animation === "hold") return { opacity: baseOpacity, dx: 0, dy: 0, scale: 1 };
  if (layer.animation === "fade-up" || layer.animation === "slide-up") {
    return { opacity: baseOpacity * progress, dx: 0, dy: (1 - progress) * 34, scale: 1 };
  }
  if (layer.animation === "scale-in") {
    return { opacity: baseOpacity * progress, dx: 0, dy: 0, scale: 0.965 + progress * 0.035 };
  }
  if (layer.animation === "subtle-parallax") {
    return { opacity: baseOpacity * progress, dx: 0, dy: Math.sin(localMs / 1000) * 8, scale: 1.02 };
  }
  return { opacity: baseOpacity * progress, dx: 0, dy: 0, scale: 1 };
}

function sceneTransform(scene: FullAdSceneSpec, localMs: number): { opacity: number; dx: number; dy: number; scale: number } {
  const progress = easeOut(localMs / SCENE_TRANSITION_DURATION_MS);
  if (scene.transition === "cut") return { opacity: 1, dx: 0, dy: 0, scale: 1 };
  if (scene.transition === "slide-left" || scene.transition === "push") return { opacity: 1, dx: (1 - progress) * SCENE_TRANSITION_TRAVEL_PX, dy: 0, scale: 1 };
  if (scene.transition === "slide-up") return { opacity: 1, dx: 0, dy: (1 - progress) * SCENE_TRANSITION_TRAVEL_PX, scale: 1 };
  return { opacity: progress, dx: 0, dy: 0, scale: 1 };
}

async function renderFrame(spec: FullAdRenderSpec, scene: FullAdSceneSpec, mediaFrames: Map<string, MediaFrames>, frameInScene: number): Promise<Buffer> {
  const fps = spec.canvas.fps;
  const localMs = (frameInScene / fps) * 1000;
  const sceneFx = sceneTransform(scene, localMs);
  const overlays: sharp.OverlayOptions[] = [];
  const sorted = [...scene.layers].sort((a, b) => a.zIndex - b.zIndex);
  for (const layer of sorted) {
    const end = layer.endTimeMs ?? scene.durationMs;
    if (localMs < layer.startTimeMs || localMs >= end) continue;
    const fx = layerTransform(layer, localMs);
    const opacity = Math.max(0, Math.min(1, fx.opacity * sceneFx.opacity));
    if (opacity <= 0.001) continue;
    if (layer.type === "text") {
      let textPng = await sharp(renderTextSvg(layer, (localMs - layer.startTimeMs) / 520, spec.brand)).png().toBuffer();
      const scaled = await scaleOverlay(textPng, fx.scale * sceneFx.scale);
      textPng = scaled.input;
      if (opacity < 0.999) textPng = await sharp(textPng).linear(opacity, 0).png().toBuffer();
      overlays.push({
        input: textPng,
        left: Math.round(layer.x + fx.dx + sceneFx.dx + scaled.dx),
        top: Math.round(layer.y + fx.dy + sceneFx.dy + scaled.dy),
      });
      continue;
    }
    const frames = mediaFrames.get(layer.assetId);
    if (!frames?.frames.length) continue;
    const elapsed = Math.max(0, localMs - layer.startTimeMs);
    const sourceIndex = frames.frames.length === 1
      ? 0
      : Math.floor((elapsed / 1000) * frames.fps) % frames.frames.length;
    let mediaPng = await renderMediaLayer(layer, frames.frames[sourceIndex]!);
    const scaled = await scaleOverlay(mediaPng, fx.scale * sceneFx.scale);
    mediaPng = scaled.input;
    if (opacity < 0.999) mediaPng = await sharp(mediaPng).linear(opacity, 0).png().toBuffer();
    if (layer.shadow) {
      const shadow = await shadowLayer(Math.round(layer.width), Math.round(layer.height), layer.borderRadius);
      const scaledShadow = await scaleOverlay(shadow, fx.scale * sceneFx.scale);
      overlays.push({
        input: scaledShadow.input,
        left: Math.round(layer.x + fx.dx + sceneFx.dx + scaled.dx - 24 + scaledShadow.dx),
        top: Math.round(layer.y + fx.dy + sceneFx.dy + scaled.dy - 2 + scaledShadow.dy),
      });
    }
    overlays.push({
      input: mediaPng,
      left: Math.round(layer.x + fx.dx + sceneFx.dx + scaled.dx),
      top: Math.round(layer.y + fx.dy + sceneFx.dy + scaled.dy),
    });
  }

  const backgroundFrame = scene.backgroundAssetId ? mediaFrames.get(scene.backgroundAssetId)?.frames[0] : null;
  let image = backgroundFrame
    ? sharp(backgroundFrame).resize(spec.canvas.width, spec.canvas.height, { fit: "cover" })
    : sharp(backgroundSvg(spec, scene));
  if (overlays.length) image = image.composite(overlays);
  return image.png({ compressionLevel: 1 }).toBuffer();
}

function parseSpec(value: unknown): FullAdRenderSpec {
  const spec = value as FullAdRenderSpec;
  if (!spec || spec.version !== 1 || !spec.canvas || !Array.isArray(spec.scenes) || !Array.isArray(spec.assets)) {
    throw new Error("Invalid full-ad render spec.");
  }
  if (spec.canvas.width !== 1080 || spec.canvas.height !== 1920) {
    throw new Error("Full-ad render spec must use a 1080x1920 canvas.");
  }
  if (!Number.isFinite(spec.canvas.fps) || spec.canvas.fps < 1 || spec.canvas.fps > 60) {
    throw new Error("Full-ad render spec fps must be between 1 and 60.");
  }
  return spec;
}

export async function renderFullAd(options: RenderAdOptions, workspace: string): Promise<RenderAdResult> {
  const inputPath = isAbsolute(options.input) ? options.input : resolveInsideWorkspace(workspace, options.input);
  const spec = parseSpec(JSON.parse(await readFile(inputPath, "utf8")));
  const outputDir = resolveInsideWorkspace(workspace, options.outputDir ?? "tanya-video-ads");
  const basename = (options.basename ?? `full-ad-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const formats = options.formats?.length ? options.formats : ["mp4", "poster"];
  const ffmpegPath = findExecutable("ffmpeg", options.ffmpegPath ?? envValue({}, "TANYA_FFMPEG_PATH"));
  const tmpRoot = resolveInsideWorkspace(workspace, ".tanya/tmp");
  const tmpDir = await fsMkdtemp(join(tmpRoot, "tanya-render-ad-"));
  const frameDir = join(tmpDir, "frames");
  const warnings: string[] = [];
  await mkdir(frameDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const mediaFrames = await buildMediaFrames(spec, workspace, tmpDir, ffmpegPath, warnings);

  let frameIndex = 0;
  const scenes = [...spec.scenes].sort((a, b) => a.order - b.order);
  for (const scene of scenes) {
    const frameCount = Math.max(1, Math.round((scene.durationMs / 1000) * spec.canvas.fps));
    for (let i = 0; i < frameCount; i += 1) {
      const frame = await renderFrame(spec, scene, mediaFrames, i);
      await writeFile(
        join(frameDir, `frame_${String(frameIndex).padStart(6, "0")}.jpg`),
        await sharp(frame).jpeg({ quality: 84, mozjpeg: true }).toBuffer(),
      );
      frameIndex += 1;
    }
  }

  const result: RenderAdResult = {
    durationMs: scenes.reduce((sum, scene) => sum + scene.durationMs, 0),
    frameCount: frameIndex,
    width: spec.canvas.width,
    height: spec.canvas.height,
    warnings,
    renderSpec: spec,
  };

  if (formats.includes("poster")) {
    const posterPath = join(outputDir, `${basename}-poster.png`);
    await sharp(await readFile(join(frameDir, "frame_000000.jpg"))).png().toFile(posterPath);
    result.posterPath = posterPath;
  }

  if (formats.includes("mp4")) {
    const mp4Path = join(outputDir, `${basename}.mp4`);
    run(ffmpegPath, [
      "-y",
      "-framerate",
      String(spec.canvas.fps),
      "-i",
      join(frameDir, "frame_%06d.jpg"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      mp4Path,
    ], workspace);
    result.mp4Path = mp4Path;
  }

  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  return result;
}

async function fsMkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  await mkdir(dirname(prefix), { recursive: true });
  return mkdtemp(prefix);
}
