import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import WebSocket from "ws";
import { envValue } from "../config/envCompat";
import type { TanyaTool, ToolContext } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";

type VideoFormat = "webm" | "mov" | "poster";
type VideoPreset = "one-terminal-simctl";
type TerminalLineKind = "cmd" | "log" | "error" | "warn";
type TerminalLine = [string, string, TerminalLineKind];

export interface GenerateVideoAssetOptions {
  preset?: VideoPreset | "terminal-simctl";
  outputDir?: string;
  basename?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  formats?: VideoFormat[];
  title?: string;
  tab?: string;
  secondaryTab?: string;
  badge?: string;
  lines?: string[];
  chromePath?: string;
  ffmpegPath?: string;
}

interface RenderConfig {
  workspace: string;
  preset: VideoPreset;
  outputDir: string;
  basename: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  formats: VideoFormat[];
  title: string;
  tab: string;
  secondaryTab: string;
  badge: string;
  lines: TerminalLine[];
  chromePath: string;
  ffmpegPath: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalStringArray(input: unknown, key: string, fallback: string[]): string[] {
  const value = asRecord(input)[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function ensureRelativePath(path: string): string {
  if (path.startsWith("/")) throw new Error(`Path must be relative to the workspace: ${path}`);
  return path;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video-asset";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findChromePath(explicit?: string): string {
  const candidates = [
    explicit,
    envValue({}, "TANYA_CHROME_PATH"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/opt/homebrew/bin/chromium",
    "/usr/local/bin/chromium",
  ].filter((path): path is string => !!path);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Chrome/Chromium not found. Set TANYA_CHROME_PATH or install Google Chrome.");
  return found;
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

function text(x: number, y: number, content: string, opts: {
  size?: number;
  fill?: string;
  weight?: number;
  family?: string;
  opacity?: number;
  anchor?: "start" | "middle" | "end";
} = {}): string {
  const size = opts.size ?? 23;
  const fill = opts.fill ?? "#d7dee8";
  const weight = opts.weight ?? 620;
  const family = opts.family ?? "Menlo, SFMono-Regular, Consolas, monospace";
  const opacity = opts.opacity ?? 1;
  const anchor = opts.anchor ?? "start";
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="${family}" opacity="${opacity}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, opts: {
  r?: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  opacity?: number;
  filter?: string;
} = {}): string {
  const r = opts.r ?? 0;
  const fill = opts.fill ?? "none";
  const stroke = opts.stroke ?? "none";
  const sw = opts.sw ?? 1;
  const opacity = opts.opacity ?? 1;
  const filter = opts.filter ? `filter="${opts.filter}"` : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" ${filter}/>`;
}

function circle(cx: number, cy: number, r: number, fill: string, opacity = 1): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="${opacity}"/>`;
}

const defaultTerminalLines: TerminalLine[] = [
  ['$ xcrun simctl boot "iPhone 16 Pro"', "#d8e0ea", "cmd"],
  ["CoreSimulator: attempting boot...", "#8fa1b3", "log"],
  ["error: device failed to boot in 60.0s", "#ff5c6c", "error"],
  ["$ xcrun simctl install booted DemoApp.app", "#d8e0ea", "cmd"],
  ["error: unable to find a booted simulator", "#ff5c6c", "error"],
  ["$ xcrun simctl io booted screenshot out.png", "#d8e0ea", "cmd"],
  ["xcrun: error: selected device is not available", "#ff5c6c", "error"],
  ["$ xcrun simctl spawn booted log stream", "#d8e0ea", "cmd"],
  ["warning: stale runtime cache detected", "#ffd166", "warn"],
  ["$ xcrun simctl erase all", "#d8e0ea", "cmd"],
  ["error: operation timed out waiting for service", "#ff5c6c", "error"],
];

export const videoPresets = [
  {
    name: "one-terminal-simctl",
    aliases: ["terminal-simctl"],
    description: "Exact native-size transparent terminal asset with failing iOS Simulator xcrun simctl commands.",
    width: 980,
    height: 1012,
    fps: 30,
    duration: 3,
  },
];

function normalizePreset(preset: GenerateVideoAssetOptions["preset"]): VideoPreset {
  if (!preset || preset === "terminal-simctl" || preset === "one-terminal-simctl") return "one-terminal-simctl";
  throw new Error(`Unsupported video preset: ${preset}`);
}

function inferLineKind(line: string): TerminalLineKind {
  if (/^\s*\$/.test(line)) return "cmd";
  if (/\b(error|failed|unable|timed out|not found|unavailable)\b/i.test(line)) return "error";
  if (/\b(warning|warn|stale)\b/i.test(line)) return "warn";
  return "log";
}

function lineColor(kind: TerminalLineKind): string {
  if (kind === "cmd") return "#d8e0ea";
  if (kind === "error") return "#ff5c6c";
  if (kind === "warn") return "#ffd166";
  return "#8fa1b3";
}

function normalizeLines(lines?: string[]): TerminalLine[] {
  const source = lines?.length ? lines : defaultTerminalLines.map(([line]) => line);
  return source.slice(0, 11).map((line) => {
    const kind = inferLineKind(line);
    return [line, lineColor(kind), kind];
  });
}

function ease(t: number): number {
  const bounded = clamp(t, 0, 1);
  return 1 - Math.pow(1 - bounded, 3);
}

function terminalSvg(config: RenderConfig, frame: number): string {
  const { width, height, fps } = config;
  const t = frame / fps;
  const enter = ease(t / 0.75);
  const marginX = Math.max(44, Math.round(width * 0.078));
  const marginY = Math.max(36, Math.round(height * 0.043));
  const w = width - marginX * 2;
  const h = height - marginY * 2 - 66;
  const x = marginX + (1 - enter) * -42;
  const y = marginY + (1 - enter) * 28 + Math.sin(t * Math.PI * 2) * 4;
  const visible = Math.min(config.lines.length, Math.floor((t - 0.14) / 0.17) + 1);
  const cursorOn = Math.floor(t * 4) % 2 === 0;
  let body = "";

  body += `<g opacity="${enter}">`;
  body += rect(x, y, w, h, { r: 28, fill: "#070b12", stroke: "#34485b", sw: 1.6, filter: "url(#terminalShadow)" });
  body += rect(x, y, w, 66, { r: 28, fill: "#111d28" });
  body += rect(x, y + 38, w, 28, { fill: "#111d28" });
  body += circle(x + 34, y + 33, 8, "#ff5f57");
  body += circle(x + 60, y + 33, 8, "#febc2e");
  body += circle(x + 86, y + 33, 8, "#28c840");
  body += rect(x + 132, y + 17, 126, 32, { r: 10, fill: "#223245", stroke: "#50657a" });
  body += text(x + 167, y + 39, config.tab, { size: 15, fill: "#dce6ef", weight: 850 });
  body += rect(x + 270, y + 17, 150, 32, { r: 10, fill: "#0b141d", stroke: "#27394b" });
  body += text(x + 292, y + 39, config.secondaryTab, { size: 15, fill: "#728495", weight: 780 });
  body += text(x + 452, y + 39, config.badge, {
    size: 15,
    fill: "#8ea0b2",
    weight: 800,
    family: "-apple-system, BlinkMacSystemFont, Helvetica, sans-serif",
  });
  body += text(x + 36, y + 113, config.title, { size: 20, fill: "#93a5b7", weight: 850 });

  for (let i = 0; i < visible; i += 1) {
    const [line, color, kind] = config.lines[i]!;
    const yy = y + 164 + i * 54;
    const opacity = ease((t - 0.14 - i * 0.17) / 0.15);
    if (kind === "error") body += rect(x + 28, yy - 33, w - 56, 42, { r: 11, fill: "#34131b", opacity: 0.77 * opacity });
    if (kind === "warn") body += rect(x + 28, yy - 33, w - 56, 42, { r: 11, fill: "#302711", opacity: 0.7 * opacity });
    if (kind === "log") body += rect(x + 28, yy - 33, w - 56, 42, { r: 11, fill: "#0f1822", opacity: 0.58 * opacity });
    body += text(x + 44, yy, line, { size: 23, fill: color, opacity, weight: kind === "cmd" ? 650 : 760 });
  }

  const cursorY = y + 164 + Math.min(visible, config.lines.length - 1) * 54 + 54;
  if (cursorOn && t > 1.8) body += rect(x + 44, cursorY - 24, 13, 29, { fill: "#7cf7d4", opacity: 0.92 });
  body += "</g>";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="terminalShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="34" stdDeviation="34" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  ${body}
</svg>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url: string, timeout = 10_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // Chrome may still be starting.
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function makeCdp(wsUrl: string) {
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const ws = new WebSocket(wsUrl);
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (!msg.id || !pending.has(msg.id)) return;
    const handlers = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) handlers.reject(new Error(JSON.stringify(msg.error)));
    else handlers.resolve(msg.result);
  });
  return {
    ready: new Promise<void>((resolveReady, rejectReady) => {
      ws.once("open", () => resolveReady());
      ws.once("error", rejectReady);
    }),
    send(method: string, params: Record<string, unknown> = {}) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise<any>((resolveSend, rejectSend) => pending.set(msgId, { resolve: resolveSend, reject: rejectSend }));
    },
    close() {
      ws.close();
    },
  };
}

async function captureFrames(config: RenderConfig, frameDir: string, svgDir: string, chromeProfile: string): Promise<void> {
  const port = 9230 + Math.floor(Math.random() * 400);
  const chrome = spawn(config.chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${chromeProfile}`,
    `--window-size=${config.width},${config.height}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const browser = makeCdp(version.webSocketDebuggerUrl);
    await browser.ready;
    const target = await browser.send("Target.createTarget", { url: "about:blank" });
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const pageInfo = targets.find((item: { id: string }) => item.id === target.targetId);
    if (!pageInfo) throw new Error("Unable to open Chrome render target.");
    const page = makeCdp(pageInfo.webSocketDebuggerUrl);
    await page.ready;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: config.width,
      height: config.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: config.width,
      screenHeight: config.height,
    });
    await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${config.width}px;height:${config.height}px;overflow:hidden;background:transparent;}svg{display:block;width:${config.width}px;height:${config.height}px;}</style></head><body></body></html>`;
    await page.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await sleep(250);

    const totalFrames = Math.round(config.fps * config.duration);
    for (let i = 0; i < totalFrames; i += 1) {
      const n = String(i + 1).padStart(4, "0");
      const svg = terminalSvg(config, i);
      await writeFile(join(svgDir, `frame-${n}.svg`), svg, "utf8");
      await page.send("Runtime.evaluate", { expression: `document.body.innerHTML = ${JSON.stringify(svg)};`, awaitPromise: true });
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        omitBackground: true,
      });
      await writeFile(join(frameDir, `frame-${n}.png`), Buffer.from(shot.data, "base64"));
    }

    page.close();
    browser.close();
  } finally {
    chrome.kill("SIGTERM");
  }
}

function normalizeOptions(options: GenerateVideoAssetOptions, workspace: string): RenderConfig {
  const preset = normalizePreset(options.preset);
  const width = Math.round(options.width ?? 980);
  const height = Math.round(options.height ?? 1012);
  const fps = Math.round(options.fps ?? 30);
  const duration = options.duration ?? 3;
  if (width < 640 || height < 640) throw new Error("Video width and height must be at least 640px.");
  if (fps < 1 || fps > 60) throw new Error("fps must be between 1 and 60.");
  if (duration <= 0 || duration > 10) throw new Error("duration must be greater than 0 and at most 10 seconds.");
  const formats = options.formats?.length ? options.formats : ["webm", "mov", "poster"];
  for (const format of formats) {
    if (!["webm", "mov", "poster"].includes(format)) throw new Error(`Unsupported video format: ${format}`);
  }
  return {
    workspace,
    preset,
    outputDir: ensureRelativePath(options.outputDir ?? "tanya-video-assets"),
    basename: sanitizeName(options.basename ?? "terminal-simctl"),
    width,
    height,
    fps,
    duration,
    formats: [...new Set(formats)] as VideoFormat[],
    title: options.title?.trim() || "zsh - iOS Simulator Control",
    tab: options.tab?.trim() || "simctl",
    secondaryTab: options.secondaryTab?.trim() || "boot logs",
    badge: options.badge?.trim() || "DemoApp Debug",
    lines: normalizeLines(options.lines),
    chromePath: findChromePath(options.chromePath),
    ffmpegPath: findExecutable("ffmpeg", options.ffmpegPath ?? envValue({}, "TANYA_FFMPEG_PATH")),
  };
}

export async function generateVideoAsset(options: GenerateVideoAssetOptions, workspace: string): Promise<{
  files: string[];
  output: Record<string, unknown>;
}> {
  const config = normalizeOptions(options, workspace);
  const outputAbs = resolveInsideWorkspace(workspace, config.outputDir);
  const tmpDir = resolveInsideWorkspace(workspace, `.tanya/video-tmp/${config.basename}-${Date.now()}`);
  const frameDir = join(tmpDir, "frames");
  const svgDir = join(tmpDir, "svg");
  const chromeProfile = join(tmpDir, "chrome-profile");
  await mkdir(frameDir, { recursive: true });
  await mkdir(svgDir, { recursive: true });
  await mkdir(outputAbs, { recursive: true });

  await captureFrames(config, frameDir, svgDir, chromeProfile);

  const files: string[] = [];
  const inputFrames = join(frameDir, "frame-%04d.png");
  const fileBase = `${config.basename}-${config.width}x${config.height}-${config.duration}s-alpha`;

  if (config.formats.includes("webm")) {
    const rel = `${config.outputDir}/${fileBase}.webm`;
    run(config.ffmpegPath, [
      "-y",
      "-framerate",
      String(config.fps),
      "-i",
      inputFrames,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-auto-alt-ref",
      "0",
      "-b:v",
      "0",
      "-crf",
      "28",
      resolveInsideWorkspace(workspace, rel),
    ], workspace);
    files.push(rel);
  }

  if (config.formats.includes("mov")) {
    const rel = `${config.outputDir}/${fileBase}.mov`;
    run(config.ffmpegPath, [
      "-y",
      "-framerate",
      String(config.fps),
      "-i",
      inputFrames,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p10le",
      resolveInsideWorkspace(workspace, rel),
    ], workspace);
    files.push(rel);
  }

  if (config.formats.includes("poster")) {
    const rel = `${config.outputDir}/${config.basename}-poster-alpha.png`;
    const posterFrame = String(Math.max(1, Math.min(Math.round(config.fps * Math.min(2, config.duration)), Math.round(config.fps * config.duration)))).padStart(4, "0");
    await mkdir(dirname(resolveInsideWorkspace(workspace, rel)), { recursive: true });
    await copyFile(join(frameDir, `frame-${posterFrame}.png`), resolveInsideWorkspace(workspace, rel));
    files.push(rel);
  }

  return {
    files,
    output: {
      preset: config.preset,
      width: config.width,
      height: config.height,
      fps: config.fps,
      duration: config.duration,
      formats: config.formats,
      files,
    },
  };
}

export const generateVideoAssetTool: TanyaTool = {
  name: "generate_video_asset",
  description: "Generate a short transparent video asset inside the workspace. Currently supports a terminal-simctl preset for failing iOS Simulator commands.",
  definition: {
    type: "function",
    function: {
      name: "generate_video_asset",
      description: "Generate a short transparent WebM/MOV video asset. Use for compositable ad or app demo assets.",
      parameters: {
        type: "object",
        properties: {
          preset: { type: "string", enum: ["one-terminal-simctl", "terminal-simctl"], description: "Video preset. terminal-simctl is an alias. Default one-terminal-simctl." },
          outputDir: { type: "string", description: "Output directory relative to workspace. Default tanya-video-assets." },
          basename: { type: "string", description: "Output filename base. Default terminal-simctl." },
          width: { type: "number", description: "Canvas width in pixels. Default 980." },
          height: { type: "number", description: "Canvas height in pixels. Default 1012." },
          fps: { type: "number", description: "Frames per second. Default 30." },
          duration: { type: "number", description: "Duration in seconds. Default 3." },
          formats: {
            type: "array",
            items: { type: "string", enum: ["webm", "mov", "poster"] },
            description: "Outputs to write. Default ['webm','mov','poster'].",
          },
          title: { type: "string", description: "Terminal title line. Default zsh - iOS Simulator Control." },
          tab: { type: "string", description: "Active tab label. Default simctl." },
          secondaryTab: { type: "string", description: "Inactive tab label. Default boot logs." },
          badge: { type: "string", description: "Small header badge text. Default DemoApp Debug." },
          lines: {
            type: "array",
            items: { type: "string" },
            description: "Optional terminal lines. Line colors are inferred from commands, warnings, and errors.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context: ToolContext) {
    const preset = asOptionalString(input, "preset") as GenerateVideoAssetOptions["preset"];
    const outputDir = asOptionalString(input, "outputDir");
    const basename = asOptionalString(input, "basename");
    const options: GenerateVideoAssetOptions = {
      width: asOptionalNumber(input, "width", 980),
      height: asOptionalNumber(input, "height", 1012),
      fps: asOptionalNumber(input, "fps", 30),
      duration: asOptionalNumber(input, "duration", 3),
      formats: optionalStringArray(input, "formats", ["webm", "mov", "poster"]) as VideoFormat[],
      lines: optionalStringArray(input, "lines", []),
    };
    if (preset) options.preset = preset;
    if (outputDir) options.outputDir = outputDir;
    if (basename) options.basename = basename;
    const title = asOptionalString(input, "title");
    const tab = asOptionalString(input, "tab");
    const secondaryTab = asOptionalString(input, "secondaryTab");
    const badge = asOptionalString(input, "badge");
    if (title) options.title = title;
    if (tab) options.tab = tab;
    if (secondaryTab) options.secondaryTab = secondaryTab;
    if (badge) options.badge = badge;
    const result = await generateVideoAsset(options, context.workspace);
    return {
      ok: true,
      summary: `Generated ${options.preset ?? "terminal-simctl"} video asset (${result.files.length} file${result.files.length === 1 ? "" : "s"}).`,
      output: result.output,
      files: result.files,
    };
  },
};
