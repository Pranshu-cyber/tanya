import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type StackDetection = {
  projectTypes: string[];
  verificationCommands: string[];
  signals: string[];
};

async function fileExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile() || entry.isDirectory();
  } catch {
    return false;
  }
}

async function readPackageJson(workspace: string): Promise<PackageJson | null> {
  const packagePath = join(workspace, "package.json");
  try {
    return JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function hasDependency(pkg: PackageJson | null, name: string): boolean {
  return !!pkg && (Object.hasOwn(pkg.dependencies ?? {}, name) || Object.hasOwn(pkg.devDependencies ?? {}, name));
}

function scriptCommand(pkg: PackageJson | null, scriptName: "typecheck" | "build" | "test"): string | null {
  const script = pkg?.scripts?.[scriptName];
  return typeof script === "string" && script.trim() ? `npm run ${scriptName}` : null;
}

async function rootEntries(workspace: string): Promise<string[]> {
  try {
    return await readdir(workspace);
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function detectStack(workspace: string): Promise<StackDetection> {
  const pkg = await readPackageJson(workspace);
  const entries = await rootEntries(workspace);
  const hasPackageJson = pkg !== null;
  const hasPrisma = await fileExists(join(workspace, "prisma", "schema.prisma"));
  const hasNextConfig = entries.some((entry) => /^next\.config\.(?:js|mjs|cjs|ts)$/.test(entry));
  const hasTsconfig = await fileExists(join(workspace, "tsconfig.json"));
  const hasGradlew = await fileExists(join(workspace, "gradlew"));
  const xcodeProjects = entries.filter((entry) => entry.endsWith(".xcodeproj"));

  const projectTypes: string[] = [];
  if (hasNextConfig || hasDependency(pkg, "next")) projectTypes.push("Next.js");
  if (hasGradlew) projectTypes.push("Android");
  if (xcodeProjects.length > 0) projectTypes.push("iOS");
  if (hasPackageJson && projectTypes.length === 0) projectTypes.push("Node");
  if (projectTypes.length === 0) projectTypes.push("Unknown");

  const verificationCommands = [
    scriptCommand(pkg, "typecheck") ?? (hasTsconfig ? "npx tsc --noEmit" : null),
    scriptCommand(pkg, "build"),
    scriptCommand(pkg, "test"),
    hasPrisma ? "npx prisma generate" : null,
    hasGradlew ? "./gradlew assembleDebug --no-daemon" : null,
    ...xcodeProjects.map((project) => `xcodebuild -list -project '${project}'`),
  ].filter((command): command is string => !!command);

  const signals = [
    hasPackageJson ? "package.json" : null,
    hasPrisma ? "prisma/schema.prisma" : null,
    hasNextConfig ? entries.find((entry) => /^next\.config\.(?:js|mjs|cjs|ts)$/.test(entry)) ?? "next.config.*" : null,
    hasTsconfig ? "tsconfig.json" : null,
    hasGradlew ? "gradlew" : null,
    ...xcodeProjects,
  ].filter((signal): signal is string => !!signal);

  return {
    projectTypes: unique(projectTypes),
    verificationCommands: unique(verificationCommands),
    signals: unique(signals),
  };
}

function buildInstructions(detection: StackDetection): string {
  const verificationLines = detection.verificationCommands.length > 0
    ? detection.verificationCommands.map((command) => `- \`${command}\``)
    : ["- Add project-specific verification commands here."];
  const signalLines = detection.signals.length > 0
    ? detection.signals.map((signal) => `- ${signal}`)
    : ["- No common stack markers detected."];

  return [
    "# Tanya Project Instructions",
    "",
    `Project type: ${detection.projectTypes.join(" / ")}`,
    "",
    "## Detected Stack Signals",
    ...signalLines,
    "",
    "## Verification Commands",
    ...verificationLines,
    "",
    "## Custom Instructions",
    "- Add project-specific rules, safety constraints, architecture notes, and preferred workflows here.",
    "",
  ].join("\n");
}

export async function initTanyaProject(cwd: string): Promise<string> {
  const workspace = resolve(cwd);
  const instructionsPath = join(workspace, ".tanya", "INSTRUCTIONS.md");
  const detection = await detectStack(workspace);
  await mkdir(dirname(instructionsPath), { recursive: true });
  try {
    await writeFile(instructionsPath, buildInstructions(detection), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST") throw new Error(`${instructionsPath} already exists. Refusing to overwrite.`);
    throw error;
  }
  return instructionsPath;
}
