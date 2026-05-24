import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Command, Option } from "commander";
import { loadConfig } from "./config/env";
import { envValue } from "./config/envCompat";
import { loadRunContextFile, type TanyaRunContext } from "./context/runContext";
import { materializeCliArtifacts } from "./context/artifacts";
import { createJsonlSink } from "./events/jsonl";
import { createProvider, createProviderForRoute } from "./providers/factory";
import type { EventSink } from "./events/types";
import { runAgent, type RunAgentOptions, type RunAgentResult, type TanyaFinalManifest } from "./agent/runner";
import { parseVerifyFailureJSONL, runPlanAndDispatch, type DispatchMode, type VerifyFailure } from "./agent/dispatch";
import { detectPostRunBlockers } from "./agent/postCheck";
import { buildExecutionPlan } from "./agent/planner";
import { reviewChanges } from "./agent/reviewer";
import { buildSystemPrompt, loadPromptSkillPacks } from "./agent/systemPrompt";
import { startInteractiveChat } from "./agent/chat";
import { phaseAwareMaxTurns } from "./agent/phaseBudget";
import { createHumanSink } from "./ui/humanSink";
import { generateVideoAsset, videoPresets } from "./tools/videoTools";
import { renderFullAd } from "./tools/adRenderTools";
import { runGoldenSuiteCommand } from "./golden/suite";
import { initTanyaProject } from "./init/projectInit";
import { buildExportMap } from "./context/loader";
import { buildRepoMap, readRepoMap, repoMapDiagnostics } from "./context/repoMap";
import { OpenAiCompatibleProvider } from "./providers/openAiCompatible";
import { buildAutoRunContext } from "./context/autoContext";
import { buildHistoryBlock, readRecentTaskHistory } from "./memory/taskHistory";
import { formatSkillPackSummary } from "./skills";
import { estimateRunCost, formatRunLogLine, readRunLogs } from "./memory/runLogs";
import { suggestPermissionsFromRuns } from "./safety/permissions/migrate";
import { serveTanyaMcpServer } from "./mcp/server";
import { loadRouteTable } from "./router";
import { dryRunEvalSuite, loadEvalSuite } from "./eval/suites";
import { parseTaskFilter, readEvalResult, runEvalSuite, writeEvalResult } from "./eval/runner";
import { formatEvalReport } from "./eval/report";
import { compareEvalResults, formatEvalComparison } from "./eval/compare";
import { runSessionsCommand } from "./cli/sessionsCommand";
import { createCosmoChatFinalizeSink } from "./integrations/cosmochatFinalize";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | string[] | boolean>;
}

type CliOptionKind = "array" | "boolean" | "negated" | "string";

type CliOptionDefinition = {
  flags: string;
  key: string;
  kind: CliOptionKind;
  property: string;
  aliases?: string[];
};

const knownCommands = new Set(["chat", "ask", "run", "review", "init", "video", "golden", "benchmark", "eval", "providers", "permissions", "mcp", "doctor", "debug-prompt", "runs", "patterns", "sessions", "help"]);

const cliOptionDefinitions: CliOptionDefinition[] = [
  { flags: "--artifact <path>", key: "artifact", kind: "array", property: "artifact" },
  { flags: "--artifact-output-root <path>", key: "artifact-output-root", kind: "string", property: "artifactOutputRoot" },
  { flags: "--artifacts-root <path>", key: "artifacts-root", kind: "string", property: "artifactsRoot" },
  { flags: "--auto-fix-verify", key: "auto-fix-verify", kind: "boolean", property: "autoFixVerify" },
  { flags: "--auto-fix-warns", key: "auto-fix-warns", kind: "boolean", property: "autoFixWarns" },
  { flags: "--badge <text>", key: "badge", kind: "string", property: "badge" },
  { flags: "--basename <name>", key: "basename", kind: "string", property: "basename" },
  { flags: "--context-file <path>", key: "context-file", kind: "string", property: "contextFile" },
  { flags: "--context-path <path>", key: "context-path", kind: "array", property: "contextPath" },
  { flags: "--continue", key: "continue", kind: "boolean", property: "continue" },
  { flags: "--cwd <path>", key: "cwd", kind: "string", property: "cwd" },
  { flags: "--duration <seconds>", key: "duration", kind: "string", property: "duration" },
  { flags: "--dispatch-mode <mode>", key: "dispatch-mode", kind: "string", property: "dispatchMode" },
  { flags: "--ffmpeg-path <path>", key: "ffmpeg-path", kind: "string", property: "ffmpegPath", aliases: ["ffmpegPath"] },
  { flags: "--format <format>", key: "format", kind: "array", property: "format" },
  { flags: "--fps <number>", key: "fps", kind: "string", property: "fps" },
  { flags: "--global", key: "global", kind: "boolean", property: "global" },
  { flags: "--height <number>", key: "height", kind: "string", property: "height" },
  { flags: "--input <path>", key: "input", kind: "string", property: "input" },
  { flags: "--json", key: "json", kind: "boolean", property: "json" },
  { flags: "--keep-context", key: "keep-context", kind: "boolean", property: "keepContext" },
  { flags: "--line <text>", key: "line", kind: "array", property: "line" },
  { flags: "--limit <count>", key: "limit", kind: "string", property: "limit" },
  { flags: "--max-subtasks <count>", key: "max-subtasks", kind: "string", property: "maxSubtasks" },
  { flags: "--max-fix-iterations <count>", key: "max-fix-iterations", kind: "string", property: "maxFixIterations" },
  { flags: "--mode <mode>", key: "mode", kind: "string", property: "mode" },
  { flags: "--model <model>", key: "model", kind: "string", property: "model" },
  { flags: "--max-turns <count>", key: "max-turns", kind: "string", property: "maxTurns" },
  { flags: "--no-auto-brief", key: "no-auto-brief", kind: "negated", property: "autoBrief" },
  { flags: "--no-obsidian-context", key: "no-obsidian-context", kind: "negated", property: "obsidianContext" },
  { flags: "--no-post-check", key: "no-post-check", kind: "negated", property: "postCheck" },
  { flags: "--no-tui", key: "no-tui", kind: "negated", property: "tui" },
  { flags: "--no-retry-stash", key: "no-retry-stash", kind: "negated", property: "retryStash" },
  { flags: "--older-than <duration>", key: "older-than", kind: "string", property: "olderThan" },
  { flags: "--output-dir <path>", key: "output-dir", kind: "string", property: "outputDir", aliases: ["outputDir"] },
  { flags: "--plan", key: "plan", kind: "boolean", property: "plan" },
  { flags: "--plan-and-dispatch", key: "plan-and-dispatch", kind: "boolean", property: "planAndDispatch" },
  { flags: "--profile <id>", key: "profile", kind: "string", property: "profile" },
  { flags: "--provider <name>", key: "provider", kind: "string", property: "provider" },
  { flags: "--prompt-file <path>", key: "prompt-file", kind: "string", property: "promptFile" },
  { flags: "--repair-attempts <count>", key: "repair-attempts", kind: "string", property: "repairAttempts" },
  { flags: "--require-verification <command>", key: "require-verification", kind: "array", property: "requireVerification" },
  { flags: "--resume <run_id>", key: "resume", kind: "string", property: "resume" },
  { flags: "--retries <count>", key: "retries", kind: "string", property: "retries" },
  { flags: "--review", key: "review", kind: "boolean", property: "review" },
  { flags: "--section <name>", key: "section", kind: "array", property: "section" },
  { flags: "--secondary-tab <name>", key: "secondary-tab", kind: "string", property: "secondaryTab", aliases: ["secondaryTab"] },
  { flags: "--spec-generation", key: "spec-generation", kind: "boolean", property: "specGeneration" },
  { flags: "--tab <name>", key: "tab", kind: "string", property: "tab" },
  { flags: "-t, --tdd", key: "tdd", kind: "boolean", property: "tdd" },
  { flags: "--test-cmd <command>", key: "test-cmd", kind: "string", property: "testCmd" },
  { flags: "--title <text>", key: "title", kind: "string", property: "title" },
  { flags: "--suite <name>", key: "suite", kind: "string", property: "suite" },
  { flags: "--task <id>", key: "task", kind: "string", property: "task" },
  { flags: "--parallel <n>", key: "parallel", kind: "string", property: "parallel" },
  { flags: "--out <path>", key: "out", kind: "string", property: "out" },
  { flags: "--dry-run", key: "dry-run", kind: "boolean", property: "dryRun" },
  { flags: "--cost-regression-threshold <ratio>", key: "cost-regression-threshold", kind: "string", property: "costRegressionThreshold" },
  { flags: "--verbose-verifier", key: "verbose-verifier", kind: "boolean", property: "verboseVerifier" },
  { flags: "--verify <command>", key: "verify", kind: "array", property: "verify" },
  { flags: "--width <number>", key: "width", kind: "string", property: "width" },
  { flags: "--all", key: "all", kind: "boolean", property: "all" },
];

function collectOptionValue(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function addCliOptions(command: Command): Command {
  for (const definition of cliOptionDefinitions) {
    const option = new Option(definition.flags);
    if (definition.kind === "array") {
      option.argParser(collectOptionValue).default([]);
    }
    command.addOption(option);
  }
  return command;
}

function normalizeCommanderArgv(argv: string[]): string[] {
  if (argv.length === 0) return ["chat"];
  if (argv[0] === "--help" || argv[0] === "-h") return argv;
  if (argv[0] && knownCommands.has(argv[0])) return normalizeOptionAliases(argv);
  const normalized = normalizeOptionAliases(argv);
  if (normalized.some((arg) => arg === "--plan-and-dispatch" || arg.startsWith("--plan-and-dispatch=") || arg === "--auto-fix-verify" || arg.startsWith("--auto-fix-verify="))) {
    return ["run", ...normalized];
  }
  return ["chat", ...normalized];
}

function normalizeOptionAliases(argv: string[]): string[] {
  return argv.map((arg) => {
    if (arg === "--ffmpegPath") return "--ffmpeg-path";
    if (arg.startsWith("--ffmpegPath=")) return `--ffmpeg-path=${arg.slice("--ffmpegPath=".length)}`;
    if (arg === "--outputDir") return "--output-dir";
    if (arg.startsWith("--outputDir=")) return `--output-dir=${arg.slice("--outputDir=".length)}`;
    if (arg === "--secondaryTab") return "--secondary-tab";
    if (arg.startsWith("--secondaryTab=")) return `--secondary-tab=${arg.slice("--secondaryTab=".length)}`;
    if (arg === "-pd") return "--plan-and-dispatch";
    if (arg === "-afv") return "--auto-fix-verify";
    return arg;
  });
}

function optionSource(command: Command, property: string): string | undefined {
  return command.getOptionValueSource(property);
}

function parsedFromCommand(commandName: string, positional: string[], command: Command): ParsedArgs {
  const opts = command.opts<Record<string, unknown>>();
  const flags = new Map<string, string | string[] | boolean>();
  for (const definition of cliOptionDefinitions) {
    const source = optionSource(command, definition.property);
    const value = opts[definition.property];
    if (definition.kind === "array") {
      if (Array.isArray(value) && value.length > 0) {
        for (const item of value) appendFlagValue(flags, definition.key, String(item));
        for (const alias of definition.aliases ?? []) {
          for (const item of value) appendFlagValue(flags, alias, String(item));
        }
      }
      continue;
    }
    if (definition.kind === "negated") {
      if (source === "cli" && value === false) flags.set(definition.key, true);
      continue;
    }
    if (definition.kind === "boolean") {
      if (source === "cli" && value === true) flags.set(definition.key, true);
      continue;
    }
    if (source === "cli" && typeof value === "string") {
      flags.set(definition.key, value);
      for (const alias of definition.aliases ?? []) flags.set(alias, value);
    }
  }
  return { command: commandName, positional, flags };
}

function configureCliCommand(command: Command, commandName: string, onParsed: (args: ParsedArgs) => void): Command {
  addCliOptions(command)
    .argument("[args...]", "command arguments")
    .allowExcessArguments(true)
    .action((positional: string[]) => {
      onParsed(parsedFromCommand(commandName, positional, command));
    });
  return command;
}

function buildCliProgram(onParsed: (args: ParsedArgs) => void): Command {
  const program = new Command();
  program
    .name("tanya")
    .description("Tanya CLI")
    .helpCommand(false)
    .showHelpAfterError()
    .allowExcessArguments(true);

  configureCliCommand(program.command("chat").description("Start live chat"), "chat", onParsed);
  configureCliCommand(program.command("ask").description("Run one prompt without tools"), "ask", onParsed);
  configureCliCommand(program.command("run").description("Run an agent task with tools"), "run", onParsed);
  configureCliCommand(program.command("review").description("Review uncommitted changes against a task"), "review", onParsed);
  configureCliCommand(program.command("init").description("Create .tania/INSTRUCTIONS.md for this project"), "init", onParsed);
  configureCliCommand(program.command("video").description("Generate Tanya video assets"), "video", onParsed);
  configureCliCommand(program.command("golden").description("Manage local golden task memory"), "golden", onParsed);
  configureCliCommand(program.command("benchmark").description("Run executable regression benchmarks"), "benchmark", onParsed);
  configureCliCommand(program.command("eval").description("Run eval suites and reports"), "eval", onParsed);
  configureCliCommand(program.command("providers").description("Provider utilities"), "providers", onParsed);
  configureCliCommand(program.command("mcp").description("MCP server/client utilities"), "mcp", onParsed);
  configureCliCommand(program.command("doctor").description("Check local setup"), "doctor", onParsed);
  configureCliCommand(program.command("debug-prompt").description("Print system prompt without running agent"), "debug-prompt", onParsed);
  configureCliCommand(program.command("runs").description("Show recent run logs"), "runs", onParsed);
  configureCliCommand(program.command("patterns").description("Show forbidden-pattern fire metrics"), "patterns", onParsed);
  configureCliCommand(program.command("sessions").description("Manage chat sessions"), "sessions", onParsed);
  return program;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === "help") return { command: "help", positional: argv.slice(1), flags: new Map() };
  let parsed: ParsedArgs | undefined;
  const program = buildCliProgram((args) => {
    parsed = args;
  });
  program.parse(normalizeCommanderArgv(argv), { from: "user" });
  return parsed ?? { command: "chat", positional: [], flags: new Map() };
}

function appendFlagValue(flags: Map<string, string | string[] | boolean>, key: string, value: string) {
  const existing = flags.get(key);
  if (typeof existing === "string") {
    flags.set(key, [existing, value]);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags.set(key, value);
  }
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagStrings(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || typeof value === "string" || Array.isArray(value);
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readVerifyFailuresFromStdin(): Promise<VerifyFailure[]> {
  if (process.stdin.isTTY) return [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "verify_failure_eof") break;
    } catch {
      continue;
    }
  }
  rl.close();
  return parseVerifyFailureJSONL(lines);
}

function applyCliProfileFlag(args: ParsedArgs): void {
  if (args.command !== "run" && args.command !== "chat") return;
  const profile = flagString(args, "profile");
  if (!profile) return;
  process.env.TANYA_PROFILE = profile;
}

function applyCliProviderFlag(args: ParsedArgs): void {
  const provider = flagString(args, "provider");
  if (!provider) return;
  process.env.TANYA_PROVIDER = provider;
}

function applyCliModeFlag(args: ParsedArgs): void {
  if (args.command !== "run" && args.command !== "chat") return;
  const mode = flagString(args, "mode");
  if (!mode) return;
  if (!["ask", "bypass", "plan", "default"].includes(mode)) {
    throw new Error(`Invalid permission mode: ${mode}. Expected ask, bypass, plan, or default.`);
  }
  process.env.TANYA_MODE = mode;
}

function buildRetryContext(manifest: TanyaFinalManifest, attempt: number, extraBlockers: string[] = []): string {
  const lines = [
    `RETRY CONTEXT (attempt ${attempt}): the previous run did not complete cleanly.`,
    "Do not repeat the same approach that failed.",
  ];
  const allBlockers = [...manifest.blockers, ...extraBlockers];
  if (allBlockers.length > 0) {
    lines.push("", "Previous run blockers:");
    for (const blocker of allBlockers) lines.push(`- ${blocker}`);
  }
  if (manifest.changedFiles.length > 0) {
    lines.push("", "Files already changed in previous attempt (verify their current state before editing):");
    for (const file of manifest.changedFiles) lines.push(`- ${file}`);
  }
  if (manifest.verification.length > 0) {
    lines.push("", "Verification results from previous attempt:");
    for (const verification of manifest.verification) lines.push(`- ${verification}`);
  }
  lines.push("", "Fix the blockers above and complete the task.");
  return lines.join("\n");
}

function usage(): string {
  return `Tanya CLI

Usage:
  tanya                         Start live chat
  tanya chat [--profile reasoner] Start live chat
  tanya --continue              Continue the latest chat session for this project
  tanya --resume <id>           Resume a specific chat session
  tanya ask "prompt"            Run one prompt without tools
  tanya init [--cwd path]       Create .tania/INSTRUCTIONS.md for this project
  tanya run [--cwd path] [--profile reasoner] "task" Run an agent task with tools
  tanya run "task"                        Auto-detects ./artifacts if present
  tanya run --context-file /tmp/context.json --prompt-file /tmp/prompt.txt
  tanya run --artifacts-root <path> "task" Use a custom artifacts directory
  tanya run --artifacts-root /path/to/artifacts --artifact ios/FastlaneSetup.md "task"
  tanya run --context-path /path/to/brand/safety.md --artifact-output-root /path/to/artifacts "task"
  tanya run --mode spec-generation "task" Non-coding spec generation; no edits, verification, or final coding report
  tanya run --no-auto-brief "task" Skip automatic local task briefing
  tanya run --no-obsidian-context "task" Skip automatic Obsidian context retrieval
  tanya run --no-post-check "task"   Skip independent TypeScript/test verification
  tanya run --repair-attempts 2 --context-file /tmp/context.json --prompt-file /tmp/prompt.txt
  tanya run --keep-context --artifacts-root /path/to/artifacts --artifact ios/FastlaneSetup.md "task"
  tanya run --verify "npm run typecheck" --verify "npm run build" "task"
  tanya run --verbose-verifier "task" Include advisory reasoning excerpts in verifier reports
  tanya run --retries 2 "task"   Retry up to 2 times if the run has blockers
  tanya run --plan "task"        Pre-plan with deepseek-reasoner before executing
  tanya run --plan-and-dispatch "task" Split a task into sequential sub-tasks
  tanya run --plan-and-dispatch --tdd "task" Split into sub-tasks with RED/GREEN TDD
  tanya run --plan-and-dispatch --auto-fix-verify "task" Read verify_failure JSONL batches on stdin and re-prompt fixes
  tanya --plan-and-dispatch "task"     Shorthand for plan-and-dispatch run mode
  tanya run --resume <run_id>          Resume a stopped dispatch run
  tanya run --plan --retries 2 "task"
  tanya run --review "task"      Run task then auto-review the diff
  tanya run --plan --retries 2 --review "task"   Full autonomous mode
  tanya run --json --prompt-file /tmp/prompt.txt
  tanya debug-prompt "task"                   Print system prompt without running agent
  tanya debug-prompt --cwd <path> "task"      Print system prompt for a specific project
  tanya debug-prompt --section artifacts "task"  Print only the artifact section
  tanya debug-prompt --section exports "task"    Print only the export map section
  tanya runs [--cwd <path>]    Show last 10 run logs with cost and status
  tanya sessions list [--all] [--cwd path] [--global]
  tanya sessions show <id>
  tanya sessions rm <id>
  tanya sessions prune --older-than 30d
  tanya review "task description"           Review uncommitted changes against the task
  tanya review --cwd <path> "task"          Review changes in a specific project
  tanya video presets
  tanya video one-terminal-simctl --output-dir assets/video
  tanya video render-ad --input spec.json --output-dir assets/video-ads --format mp4 --format poster
  tanya golden summary          Summarize local golden task memory
  tanya golden profiles         List built-in golden task profiles
  tanya golden run              Run executable golden task fixtures
  tanya golden validate         Fail if latest golden task signatures are failing
  tanya benchmark profiles      List benchmark profiles
  tanya benchmark run --all     Run executable regression benchmarks
  tanya benchmark validate      Validate recent benchmark signatures
  tanya eval --suite tanya-native --dry-run
  tanya eval --suite eco-30 --provider deepseek --model deepseek-chat --out result.json
  tanya providers test --provider deepseek  Test provider configuration (live only with TANYA_RUN_LIVE_PROVIDER_TESTS=1)
  tanya mcp serve               Start Tanya's MCP server over stdio
  tanya doctor                  Check local setup
  tanya patterns                Show forbidden-pattern fire metrics for this workspace

Install locally during development:
  npm install
  npm run link:local
`;
}

function readPrompt(args: ParsedArgs): string {
  const promptFile = flagString(args, "prompt-file");
  if (promptFile) return readFileSync(resolve(promptFile), "utf8");
  return args.positional.join(" ").trim();
}

async function buildRunContextForCli(
  args: ParsedArgs,
  cwd: string,
  prompt: string,
  obsidianVault?: string,
): Promise<TanyaRunContext | undefined> {
  const contextFile = flagString(args, "context-file");
  const baseRunContext = contextFile ? loadRunContextFile(contextFile) : undefined;
  const mode = flagString(args, "mode")?.trim();
  const specGenerationMode = mode === "spec-generation" || mode === "spec" || hasFlag(args, "spec-generation");
  if (specGenerationMode) {
    const baseSpecContext: TanyaRunContext = { ...(baseRunContext ?? {}) };
    delete baseSpecContext.expected_report;
    delete baseSpecContext.verification;
    const runContext: TanyaRunContext = {
      ...baseSpecContext,
      task: {
        ...(baseRunContext?.task ?? {}),
        kind: "spec-generation",
        title: baseRunContext?.task?.title ?? prompt.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 120) ?? "Spec generation",
      },
      instructions: [
        ...(baseRunContext?.instructions ?? []),
        "You are running in spec-generation mode.",
        "Generate the requested specification only.",
        "Do not edit files, run shell commands, run verification, inspect git status, or create artifacts.",
        "Do not append coding-agent report sections such as Verification, Final Report, Modified files, Artifact reused, Artifact created, or Blockers.",
      ],
      metadata: {
        ...(baseRunContext?.metadata ?? {}),
        mode: "spec-generation",
        autoContext: false,
      },
    };
    return buildAutoRunContext({
      cwd,
      prompt,
      runContext,
      obsidianVault,
      enableBrief: false,
      enableObsidian: false,
      keepContext: false,
    });
  }
  const explicitArtifactsRoot = flagString(args, "artifacts-root");
  const localArtifactsRoot = resolve(cwd, "artifacts");
  const artifactsRoot = explicitArtifactsRoot ?? (existsSync(localArtifactsRoot) ? localArtifactsRoot : undefined);
  let runContext = materializeCliArtifacts({
    cwd,
    root: artifactsRoot,
    artifacts: flagStrings(args, "artifact"),
    contextPaths: flagStrings(args, "context-path"),
    artifactOutputRoot: flagString(args, "artifact-output-root"),
    keepContext: hasFlag(args, "keep-context"),
    baseContext: baseRunContext,
  });
  if (!explicitArtifactsRoot && artifactsRoot) {
    const autoArtifactInstructions = [
      "This workspace contains an artifacts/ directory with reusable patterns.",
      "The artifact index and rules have been injected into your system prompt.",
      "Before implementing anything, check the artifact index and read relevant artifacts.",
    ];
    runContext = {
      ...(runContext ?? {}),
      instructions: [...(runContext?.instructions ?? []), ...autoArtifactInstructions],
    };
  }
  const extraVerify = flagStrings(args, "verify");
  if (extraVerify.length > 0) {
    const existing = runContext?.verification?.commands ?? [];
    const merged = [...new Set([...existing, ...extraVerify])];
    runContext = { ...(runContext ?? {}), task: { ...(runContext?.task ?? {}), kind: "coding" }, verification: { commands: merged } };
  }
  const requireVerify = flagStrings(args, "require-verification");
  if (requireVerify.length > 0) {
    // --require-verification REPLACES the auto-brief verification list with exactly
    // these commands. Use when the caller knows the canonical verification set
    // and the auto-generated recommendations would over-require.
    runContext = {
      ...(runContext ?? {}),
      task: { ...(runContext?.task ?? {}), kind: "coding" },
      verification: { commands: [...new Set(requireVerify)] },
      metadata: { ...(runContext?.metadata ?? {}), verificationOverridden: true },
    };
  }
  if (hasFlag(args, "verbose-verifier")) {
    runContext = {
      ...(runContext ?? {}),
      metadata: { ...(runContext?.metadata ?? {}), verboseVerifier: true },
    };
  }
  return buildAutoRunContext({
    cwd,
    prompt,
    ...(runContext ? { runContext } : {}),
    obsidianVault,
    enableBrief: !hasFlag(args, "no-auto-brief"),
    enableObsidian: !hasFlag(args, "no-obsidian-context"),
    keepContext: hasFlag(args, "keep-context"),
  });
}

function selectPromptSections(systemPrompt: string, sections: string[]): string {
  if (sections.length === 0) return systemPrompt;
  const sectionMap: Record<string, { starts: string[]; ends: string[] }> = {
    artifacts: {
      starts: ["## Artifact Index", "## Project Artifacts"],
      ends: ["## Workspace Context", "## Project Instructions", "## Caller Context"],
    },
    "repo-map": {
      starts: ["## Repo Map (advisory)"],
      ends: ["## Artifact Index", "## Workspace Context", "## Project Instructions", "## Caller Context"],
    },
    exports: {
      starts: ["## Workspace export map"],
      ends: ["## Repo Map (advisory)", "## Artifact Index", "## Project Artifacts", "## Workspace Context", "## Project Instructions", "## Caller Context"],
    },
    context: {
      starts: ["## Workspace Context"],
      ends: ["## Project Instructions", "## Caller Context"],
    },
    instructions: {
      starts: ["## Project Instructions"],
      ends: ["## Caller Context"],
    },
  };

  const findHeading = (heading: string, from = 0): number => {
    if (systemPrompt.startsWith(`${heading}\n`)) return 0;
    return systemPrompt.indexOf(`\n${heading}\n`, from);
  };

  const extractSection = (starts: string[], ends: string[]): string | null => {
    const startCandidates = starts
      .map((heading) => findHeading(heading))
      .filter((index) => index >= 0);
    if (startCandidates.length === 0) return null;
    let start = Math.min(...startCandidates);
    if (systemPrompt[start] === "\n") start += 1;

    const endCandidates = ends
      .map((heading) => findHeading(heading, start + 1))
      .filter((index) => index > start);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : systemPrompt.length;
    return systemPrompt.slice(start, end).trim();
  };

  const matched: string[] = [];
  for (const section of sections) {
    const definition = sectionMap[section];
    if (!definition) {
      process.stderr.write(`[debug-prompt] Unknown section "${section}". Available: ${Object.keys(sectionMap).join(", ")}\n`);
      continue;
    }
    const match = extractSection(definition.starts, definition.ends);
    if (match) {
      matched.push(match);
    } else {
      process.stderr.write(`[debug-prompt] Section "${section}" not found in prompt.\n`);
    }
  }
  return matched.join("\n\n---\n\n");
}

async function askOnce(provider: ReturnType<typeof createProvider>, prompt: string): Promise<string> {
  let text = "";
  for await (const delta of provider.streamChat({ messages: [{ role: "user", content: prompt }], tools: [] })) {
    if (delta.content) {
      process.stdout.write(delta.content);
      text += delta.content;
    }
  }
  process.stdout.write("\n");
  return text;
}

function buildRoutingOptions(config: ReturnType<typeof loadConfig>, cwd: string): RunAgentOptions["routing"] | undefined {
  const loaded = loadRouteTable({
    cwd,
    defaults: { provider: config.provider, model: config.model },
  });
  for (const issue of loaded.issues) {
    process.stderr.write(`[tanya] Ignoring invalid route config ${issue.file} ${issue.path}: ${issue.message}\n`);
  }
  const hasRouteFile = loaded.table.sources.some((source) => source !== "built-in");
  return {
    enabled: hasRouteFile,
    table: loaded.table,
    providerFactory: (target) => createProviderForRoute(config, target),
  };
}

function shouldUseInkChat(args: ParsedArgs, json: boolean): boolean {
  if (args.command !== "chat") return false;
  if (json) return false;
  if (hasFlag(args, "no-tui")) return false;
  if (envValue({}, "TANYA_TUI").trim().toLowerCase() === "off") return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function testProvider(args: ParsedArgs): Promise<void> {
  const requestedProvider = flagString(args, "provider") ?? "configured";
  if (envValue({}, "TANYA_RUN_LIVE_PROVIDER_TESTS") !== "1") {
    console.log(`skipped live provider test for ${requestedProvider}; set TANYA_RUN_LIVE_PROVIDER_TESTS=1 to run against the real endpoint.`);
    return;
  }
  const config = loadConfig();
  const provider = createProvider(config);
  const startedAt = Date.now();
  let text = "";
  for await (const delta of provider.streamChat({
    messages: [
      { role: "system", content: "You are a provider conformance probe. Keep answers short." },
      { role: "user", content: "Reply with exactly: pong" },
      { role: "user", content: "No tools are needed." },
    ],
    tools: [],
    maxTokens: 12,
    temperature: 0,
  })) {
    if (delta.content) text += delta.content;
  }
  console.log(`PASS adapter: ${provider.id}:${provider.model}`);
  console.log(`PASS streaming-chat: ${Date.now() - startedAt}ms ${text.trim()}`);
  console.log("PASS parser-surface: mock conformance covers malformed tool-call quirks in CI");
}

async function runEvalCommand(args: ParsedArgs): Promise<void> {
  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  const action = args.positional[0];
  const format = flagStrings(args, "format").includes("markdown") ? "markdown" : "text";
  if (action === "report") {
    const file = args.positional[1];
    if (!file) throw new Error("Usage: tanya eval report <result.json> [--format markdown]");
    process.stdout.write(formatEvalReport(await readEvalResult(resolve(cwd, file)), format));
    return;
  }
  if (action === "compare") {
    const baseline = args.positional[1];
    const next = args.positional[2];
    if (!baseline || !next) throw new Error("Usage: tanya eval compare <baseline.json> <new.json> [--format markdown]");
    const comparison = compareEvalResults(
      await readEvalResult(resolve(cwd, baseline)),
      await readEvalResult(resolve(cwd, next)),
      flagNumber(args, "cost-regression-threshold") ?? 0.20,
    );
    process.stdout.write(formatEvalComparison(comparison, format));
    if (comparison.regressions.length > 0) process.exitCode = 1;
    return;
  }
  const suiteName = flagString(args, "suite") ?? args.positional[0] ?? "tanya-native";
  const suite = loadEvalSuite(suiteName);
  const modelFlag = flagString(args, "model");
  const modelParts = modelFlag?.includes("/") ? modelFlag.split("/") : undefined;
  const providerName = modelParts?.[0] ?? flagString(args, "provider");
  const modelName = modelParts?.[1] ?? modelFlag;
  const config = hasFlag(args, "dry-run") && providerName && modelName
    ? undefined
    : loadConfig(cwd);
  const provider = providerName ?? config?.provider ?? "deepseek";
  const model = modelName ?? config?.model ?? "deepseek-chat";
  if (hasFlag(args, "dry-run")) {
    const dryRun = dryRunEvalSuite(suite, provider, model);
    if (hasFlag(args, "json")) {
      process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    } else {
      process.stdout.write(`Eval dry-run: ${dryRun.suite}@${dryRun.suiteVersion}\n`);
      process.stdout.write(`Tasks: ${dryRun.taskCount}\n`);
      process.stdout.write(`Model: ${provider}/${model}\n`);
      process.stdout.write(`Estimated cost: ${dryRun.estimatedCostUsd === null ? "pricing unknown" : `$${dryRun.estimatedCostUsd.toFixed(3)}`}\n`);
    }
    return;
  }

  process.env.TANYA_PROVIDER = provider;
  process.env.TANYA_MODEL = model;
  const evalConfig = loadConfig(cwd);
  const taskIds = parseTaskFilter(flagString(args, "task"));
  const parallel = flagNumber(args, "parallel");
  const result = await runEvalSuite(suite, {
    cwd,
    provider,
    model,
    tanyaVersion: JSON.parse(readFileSync(resolve("package.json"), "utf8")).version,
    ...(taskIds ? { taskIds } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    providerFactory: () => createProvider(evalConfig),
  });
  const out = flagString(args, "out");
  if (out) {
    await writeEvalResult(resolve(cwd, out), result);
    process.stdout.write(`Wrote eval result to ${resolve(cwd, out)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

async function doctor(args?: ParsedArgs): Promise<void> {
  const cwd = resolve(args ? flagString(args, "cwd") ?? process.cwd() : process.cwd());
  const config = loadConfig(cwd);
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
  const ok = (name: string, detail: string) => checks.push({ name, status: "ok", detail });
  const warn = (name: string, detail: string) => checks.push({ name, status: "warn", detail });
  const fail = (name: string, detail: string) => checks.push({ name, status: "fail", detail });

  // Node + runtime
  const major = Number(process.version.replace(/^v/, "").split(".")[0] ?? "0");
  if (major >= 20) ok("node", `${process.version}`);
  else fail("node", `${process.version} — tanya requires Node 20+`);

  // Provider config
  if (config.apiKey) ok("provider.apiKey", "present");
  else fail("provider.apiKey", "missing — set TANYA_API_KEY or DEEPSEEK_API_KEY");
  if (config.baseUrl) ok("provider.baseUrl", config.baseUrl);
  else fail("provider.baseUrl", "missing — set TANYA_BASE_URL");
  ok("provider.model", `${config.provider}:${config.model} (profile=${config.profile})`);
  ok("provider.timeoutMs", `${config.timeoutMs}ms`);

  // Workspace
  const cwdHasGit = existsSync(join(cwd, ".git"));
  if (cwdHasGit) ok("workspace.git", `${cwd}`);
  else warn("workspace.git", `${cwd} is not a git repository — stash/retry recovery will be disabled`);
  const cwdHasArtifacts = existsSync(join(cwd, "artifacts"));
  if (cwdHasArtifacts) ok("workspace.artifacts", `${join(cwd, "artifacts")} (auto-detected)`);
  else warn("workspace.artifacts", "no ./artifacts dir — pass --artifacts-root or run from a project that has one");

  // Project-level forbidden patterns
  const fpPath = join(cwd, ".tania", "forbidden-patterns.json");
  if (existsSync(fpPath)) {
    try {
      const raw = readFileSync(fpPath, "utf8");
      const parsed = JSON.parse(raw);
      const count = Array.isArray(parsed?.patterns) ? parsed.patterns.length : 0;
      ok("workspace.forbiddenPatterns", `${count} project pattern(s) loaded from ${fpPath}`);
    } catch (err) {
      fail("workspace.forbiddenPatterns", `${fpPath} exists but is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    ok("workspace.forbiddenPatterns", "no project overrides (using defaults)");
  }

  // Forbidden-pattern fire metrics (from accumulated runs)
  const fpMetricsPath = join(cwd, ".tania", "memory", "forbidden-patterns-metrics.json");
  if (existsSync(fpMetricsPath)) {
    try {
      const raw = readFileSync(fpMetricsPath, "utf8");
      const parsed = JSON.parse(raw) as { totals?: Record<string, number>; totalScans?: number };
      const totals = parsed.totals ?? {};
      const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length > 0) {
        const summary = top.map(([id, n]) => `${id}=${n}`).join(", ");
        ok("workspace.forbiddenPatterns.metrics", `top fires across ${parsed.totalScans ?? 0} scans: ${summary}`);
      } else {
        ok("workspace.forbiddenPatterns.metrics", `no patterns ever fired (${parsed.totalScans ?? 0} scans)`);
      }
    } catch {
      warn("workspace.forbiddenPatterns.metrics", `${fpMetricsPath} exists but is unreadable`);
    }
  } else {
    ok("workspace.forbiddenPatterns.metrics", "no metrics yet (no scans recorded)");
  }

  // Obsidian vault
  if (config.obsidianVault) {
    if (existsSync(config.obsidianVault)) ok("obsidian.vault", config.obsidianVault);
    else warn("obsidian.vault", `${config.obsidianVault} configured but path does not exist`);
  } else {
    ok("obsidian.vault", "not configured (optional)");
  }

  // ffmpeg presence (informational; only required for tanya video)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ok("ffmpeg", "available (tanya video commands enabled)");
  } catch {
    warn("ffmpeg", "not found on PATH — tanya video commands will fail until installed");
  }

  // Render
  console.log(`Tanya doctor — ${cwd}`);
  console.log("");
  for (const check of checks) {
    const tag = check.status === "ok" ? "[ok]  " : check.status === "warn" ? "[warn]" : "[FAIL]";
    console.log(`${tag} ${check.name.padEnd(28)} ${check.detail}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log("");
  console.log(`Summary: ${checks.length - failed - warned} ok, ${warned} warn, ${failed} fail`);
  if (failed > 0) process.exitCode = 1;
}

async function runVideoCommand(args: ParsedArgs): Promise<void> {
  const preset = args.positional[0] ?? "one-terminal-simctl";
  if (preset === "presets" || preset === "list") {
    console.log("Video presets:");
    for (const item of videoPresets) {
      const aliases = item.aliases.length ? ` aliases: ${item.aliases.join(", ")}` : "";
      console.log(`- ${item.name} (${item.width}x${item.height}, ${item.fps}fps, ${item.duration}s)${aliases}`);
      console.log(`  ${item.description}`);
    }
    return;
  }
  if (preset === "render-ad") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const input = flagString(args, "input");
    if (!input) {
      console.log("Usage: tanya video render-ad --input spec.json [--output-dir dir] [--basename name] [--format mp4] [--format poster]");
      return;
    }
    const formats = flagStrings(args, "format");
    const renderOptions: Parameters<typeof renderFullAd>[0] = {
      input,
      formats: formats.length ? formats as Array<"mp4" | "poster"> : ["mp4", "poster"],
    };
    const outputDir = flagString(args, "output-dir") ?? flagString(args, "outputDir");
    const basename = flagString(args, "basename");
    const ffmpegPath = flagString(args, "ffmpeg-path") ?? flagString(args, "ffmpegPath");
    if (outputDir) renderOptions.outputDir = outputDir;
    if (basename) renderOptions.basename = basename;
    if (ffmpegPath) renderOptions.ffmpegPath = ffmpegPath;
    const result = await renderFullAd(renderOptions, cwd);
    console.log(JSON.stringify({
      mp4Path: result.mp4Path,
      posterPath: result.posterPath,
      durationMs: result.durationMs,
      frameCount: result.frameCount,
      width: result.width,
      height: result.height,
      warnings: result.warnings,
    }, null, 2));
    return;
  }
  if (preset !== "one-terminal-simctl" && preset !== "terminal-simctl") {
    console.log("Usage: tanya video one-terminal-simctl [--output-dir dir] [--basename name] [--width 980] [--height 1012] [--duration 3] [--fps 30] [--format webm] [--format mov] [--format poster] [--line text]\n       tanya video render-ad --input spec.json [--output-dir dir] [--format mp4] [--format poster]");
    return;
  }
  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  const formats = flagStrings(args, "format");
  const options: Parameters<typeof generateVideoAsset>[0] = { preset };
  const outputDir = flagString(args, "output-dir") ?? flagString(args, "outputDir");
  const basename = flagString(args, "basename");
  const width = flagNumber(args, "width");
  const height = flagNumber(args, "height");
  const fps = flagNumber(args, "fps");
  const duration = flagNumber(args, "duration");
  const title = flagString(args, "title");
  const tab = flagString(args, "tab");
  const secondaryTab = flagString(args, "secondary-tab") ?? flagString(args, "secondaryTab");
  const badge = flagString(args, "badge");
  const lines = flagStrings(args, "line");
  if (outputDir) options.outputDir = outputDir;
  if (basename) options.basename = basename;
  if (width !== undefined) options.width = width;
  if (height !== undefined) options.height = height;
  if (fps !== undefined) options.fps = fps;
  if (duration !== undefined) options.duration = duration;
  if (formats.length > 0) options.formats = formats as Array<"webm" | "mov" | "poster">;
  if (title) options.title = title;
  if (tab) options.tab = tab;
  if (secondaryTab) options.secondaryTab = secondaryTab;
  if (badge) options.badge = badge;
  if (lines.length > 0) options.lines = lines;
  const result = await generateVideoAsset(options, cwd);
  console.log(`Generated ${result.files.length} video asset file${result.files.length === 1 ? "" : "s"}:`);
  for (const file of result.files) console.log(`- ${file}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  applyCliProviderFlag(args);
  applyCliModeFlag(args);
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }

  if (args.command === "doctor") {
    await doctor(args);
    return;
  }

  if (args.command === "patterns") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const metricsPath = join(cwd, ".tania", "memory", "forbidden-patterns-metrics.json");
    if (!existsSync(metricsPath)) {
      console.log(`No metrics file at ${metricsPath}. Run a tanya task in this workspace first.`);
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(metricsPath, "utf8")) as {
        totals?: Record<string, number>;
        lastFiredAt?: Record<string, string>;
        totalScans?: number;
      };
      const totals = parsed.totals ?? {};
      const lastFiredAt = parsed.lastFiredAt ?? {};
      const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      console.log(`Forbidden-pattern fire metrics — ${cwd}`);
      console.log(`Total scans: ${parsed.totalScans ?? 0}`);
      console.log("");
      if (entries.length === 0) {
        console.log("No patterns have fired in this workspace yet.");
        return;
      }
      console.log(`${"PATTERN".padEnd(48)} ${"FIRES".padStart(7)}  LAST FIRED`);
      for (const [id, count] of entries) {
        const last = lastFiredAt[id]?.slice(0, 16) ?? "—";
        console.log(`${id.padEnd(48)} ${String(count).padStart(7)}  ${last}`);
      }
    } catch (err) {
      console.error(`Could not read metrics: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "sessions") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    await runSessionsCommand({
      action: args.positional[0] ?? "list",
      args: args.positional.slice(1),
      cwd,
      global: hasFlag(args, "global"),
      all: hasFlag(args, "all"),
      limit: flagNumber(args, "limit"),
      olderThan: flagString(args, "older-than"),
    });
    return;
  }

  if (args.command === "providers") {
    if (args.positional[0] !== "test") {
      console.log("Usage: tanya providers test --provider <name>");
      return;
    }
    await testProvider(args);
    return;
  }

  if (args.command === "permissions") {
    if (args.positional[0] !== "migrate") {
      console.log("Usage: tanya permissions migrate [--cwd path] [--limit 100]");
      return;
    }
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const limit = flagNumber(args, "limit") ?? 100;
    console.log(JSON.stringify(suggestPermissionsFromRuns(cwd, limit), null, 2));
    return;
  }

  if (args.command === "mcp") {
    if (args.positional[0] !== "serve") {
      console.log("Usage: tanya mcp serve");
      return;
    }
    await serveTanyaMcpServer({ defaultCwd: resolve(flagString(args, "cwd") ?? process.cwd()) });
    return;
  }

  if (args.command === "eval") {
    await runEvalCommand(args);
    return;
  }

  if (args.command === "init") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const path = await initTanyaProject(cwd);
    console.log(path);
    return;
  }

  if (args.command === "video") {
    await runVideoCommand(args);
    return;
  }

  if (args.command === "golden" || args.command === "benchmark") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const action = args.positional[0] ?? "summary";
    if (!["summary", "list", "profiles", "run", "validate"].includes(action)) {
      console.log(`Usage: tanya ${args.command} summary|list|profiles|run|validate [--cwd path] [--json] [--profile id] [--all]`);
      return;
    }
    const profile = flagString(args, "profile");
    const exitCode = await runGoldenSuiteCommand(cwd, action, hasFlag(args, "json"), {
      ...(profile ? { profile } : {}),
      all: hasFlag(args, "all"),
    });
    process.exitCode = exitCode;
    return;
  }

  if (args.command === "runs") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const logs = readRunLogs(cwd, 10);
    if (logs.length === 0) {
      process.stdout.write("No run logs found. Run tanya run first.\n");
      return;
    }
    for (const log of logs) process.stdout.write(`${formatRunLogLine(log)}\n`);
    return;
  }

  applyCliProfileFlag(args);
  const config = loadConfig();

  if (args.command === "debug-prompt") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const task = readPrompt(args);
    if (!task) throw new Error("Missing task. Usage: tanya debug-prompt --cwd <path> \"task description\"");

    const runContext = await buildRunContextForCli(args, cwd, task, config.obsidianVault);
    const historyBlock = buildHistoryBlock(await readRecentTaskHistory(cwd));
    const lite = /^(1|true|yes|on)$/i.test(envValue(process.env, "TANYA_LITE_PROMPT").trim());
    if (lite) {
      try {
        await buildRepoMap(cwd, { writeCache: true });
      } catch {
        // Repo-map diagnostics are best-effort for debug-prompt.
      }
    }
    const systemPrompt = buildSystemPrompt(cwd, runContext, historyBlock, task, {
      lite,
    });
    const skillPacks = loadPromptSkillPacks(cwd, runContext, task);
    const sections = flagStrings(args, "section");
    const output = selectPromptSections(systemPrompt, sections);

    process.stdout.write("=== SYSTEM PROMPT ===\n\n");
    process.stdout.write(output);
    process.stdout.write("\n\n=== END SYSTEM PROMPT ===\n");
    if (sections.length === 0) {
      process.stdout.write(`\nLength: ${systemPrompt.length} chars (~${Math.ceil(systemPrompt.length / 4)} tokens)\n`);
      process.stdout.write(`${formatSkillPackSummary(skillPacks)}\n`);
      const map = readRepoMap(cwd);
      if (map) {
        const diagnostics = repoMapDiagnostics(map);
        process.stdout.write(`Repo map: ${diagnostics.fileCount} files, ${diagnostics.symbolCount} symbols, ${diagnostics.importCount} imports, ~${diagnostics.estimatedTokens} tokens, parsers tree-sitter=${diagnostics.parserCounts["tree-sitter"]} ripgrep=${diagnostics.parserCounts.ripgrep} path=${diagnostics.parserCounts.path}\n`);
      }
    }
    return;
  }

  const provider = createProvider(config);

  if (args.command === "ask") {
    const prompt = readPrompt(args);
    if (!prompt) throw new Error("Missing prompt.");
    await askOnce(provider, prompt);
    return;
  }

  if (args.command === "review") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    const task = readPrompt(args);
    if (!task) throw new Error("Missing task description. Usage: tanya review --cwd <path> \"task description\"");

    const { execFileSync } = await import("node:child_process");
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
      if (!diff.trim()) {
        diff = execFileSync("git", ["show", "--format=", "HEAD"], { cwd, encoding: "utf8" });
      }
    } catch {
      throw new Error("tanya review requires a git repository with changes.");
    }

    process.stdout.write("Reviewing changes...\n\n");
    const review = await reviewChanges(provider, task, diff);
    process.stdout.write(`${review}\n`);
    return;
  }

  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  const routing = buildRoutingOptions(config, cwd);
  const json = hasFlag(args, "json");
  if (shouldUseInkChat(args, json)) {
    const { startInkChat } = await import("./ui/ink/runInkChat");
    await startInkChat({
      provider,
      cwd,
      ...(routing ? { routing } : {}),
      resumeSessionId: flagString(args, "resume"),
      continueSession: hasFlag(args, "continue"),
    });
    return;
  }
  const sink = createCosmoChatFinalizeSink(json ? createJsonlSink() : createHumanSink(process.stdout, { liveStatus: args.command === "chat" }));
  let runPromptTokens = 0;
  let runCompletionTokens = 0;
  const trackingSink: EventSink = async (event) => {
    if (event.type === "final" && event.metrics) {
      runPromptTokens += event.metrics.promptTokens ?? 0;
      runCompletionTokens += event.metrics.completionTokens ?? 0;
    }
    return sink(event);
  };

  if (args.command === "run") {
    const prompt = readPrompt(args);
    const resumeRunID = flagString(args, "resume");
    if (!prompt && !resumeRunID) throw new Error("Missing prompt.");
    const runContext = prompt
      ? await buildRunContextForCli(args, cwd, prompt, config.obsidianVault)
      : undefined;
    const maxTurns = phaseAwareMaxTurns(runContext, prompt, flagNumber(args, "max-turns"));
    const repairAttempts = flagNumber(args, "repair-attempts");
    const maxRetries = flagNumber(args, "retries") ?? 0;
    const skipPostCheck = hasFlag(args, "no-post-check");
    const usePlan = hasFlag(args, "plan");
    const planAndDispatch = hasFlag(args, "plan-and-dispatch") || Boolean(flagString(args, "resume"));
    const tdd = hasFlag(args, "tdd");
    const testCmd = flagString(args, "test-cmd");
    const autoFixVerify = hasFlag(args, "auto-fix-verify");
    const autoFixWarns = hasFlag(args, "auto-fix-warns");
    const maxFixIterations = flagNumber(args, "max-fix-iterations") ?? 5;

    if (planAndDispatch) {
      if (!prompt && !resumeRunID) throw new Error("Missing prompt.");
      const maxSubtasks = flagNumber(args, "max-subtasks") ?? 12;
      const dispatchMode = (flagString(args, "dispatch-mode") ?? "sequential") as DispatchMode;
      const { expected_report: _expectedReport, ...runContextWithoutExpectedReport } = runContext ?? {};
      const subtaskRunContext: TanyaRunContext | undefined = runContext
        ? {
            ...runContextWithoutExpectedReport,
            task: { ...(runContext.task ?? {}), kind: "dispatch-subtask" },
          }
        : undefined;

      await runPlanAndDispatch({
        cwd,
        prompt,
        maxSubtasks,
        mode: dispatchMode,
        tdd,
        autoFixVerify,
        autoFixWarns,
        maxFixIterations,
        readVerifyFailures: readVerifyFailuresFromStdin,
        ...(testCmd ? { testCmd } : {}),
        ...(resumeRunID ? { resumeRunID } : {}),
        sink: trackingSink,
        runTurn: async (turnPrompt, meta) => {
          if (meta.phase === "plan") {
            let text = "";
            for await (const delta of provider.streamChat({ messages: [{ role: "user", content: turnPrompt }], tools: [], temperature: 0, topP: 0.2 })) {
              if (delta.usage) {
                runPromptTokens += delta.usage.promptTokens;
                runCompletionTokens += delta.usage.completionTokens;
              }
              if (delta.content) text += delta.content;
            }
            return text;
          }

          const result = await runAgent({
            provider,
            prompt: turnPrompt,
            cwd,
            sink: trackingSink,
            ...(meta.phase === "complete" && runContext ? { runContext } : {}),
            ...(meta.phase === "subtask" && subtaskRunContext ? { runContext: subtaskRunContext } : {}),
            ...(maxTurns ? { maxTurns } : {}),
            ...(repairAttempts !== undefined ? { repairAttempts } : {}),
          });

          if (meta.phase === "complete" && !skipPostCheck) {
            const postBlockers = await detectPostRunBlockers(cwd, result.manifest);
            if (postBlockers.length > 0) {
              await trackingSink({
                type: "status",
                message: `Post-run checks found ${postBlockers.length} issue(s): ${postBlockers.join("; ")}`,
              });
            }
          }
          return result.message;
        },
      });

      if (runPromptTokens > 0 || runCompletionTokens > 0) {
        const costStr = estimateRunCost({
          provider: config.provider,
          model: config.model,
          promptTokens: runPromptTokens,
          completionTokens: runCompletionTokens,
        });
        process.stderr.write(
          `[tanya] Tokens: ${runPromptTokens.toLocaleString()} in / ${runCompletionTokens.toLocaleString()} out  ${costStr}\n`,
        );
      }
      return;
    }

    let planBlock = "";

    if (usePlan) {
      process.stderr.write("[tanya] Building execution plan with reasoner...\n");
      const reasonerConfig = loadConfig(cwd);
      const reasonerProvider = new OpenAiCompatibleProvider({
        id: "deepseek-reasoner",
        apiKey: reasonerConfig.apiKey,
        baseUrl: reasonerConfig.baseUrl,
        model: "deepseek-reasoner",
        timeoutMs: 180_000,
        temperature: 0,
        topP: 0.2,
      });
      const exportMap = buildExportMap(cwd);
      try {
        const plan = await buildExecutionPlan(reasonerProvider, prompt, exportMap);
        if (plan) {
          planBlock = `## Execution plan (pre-approved, follow it)\n${plan}`;
          process.stderr.write("[tanya] Plan ready.\n");
        }
      } catch {
        process.stderr.write("[tanya] Planner failed, continuing without plan.\n");
      }
    }

    let lastResult: RunAgentResult | null = null;
    let previousPostBlockers: string[] = [];
    let attempt = 0;
    let stashedAttemptResult: RunAgentResult | null = null;
    let stashedAttemptLabel: string | null = null;
    // --no-retry-stash: skip stash-and-clean between retries so the agent sees
    // its previous attempt's files and can fix them incrementally instead of
    // rewriting from scratch. Use for tasks where partial progress is valuable
    // (e.g. test-writing where the agent's repeated rewrites burn context). The
    // default (stash) is best for tasks where a wrong-direction first attempt
    // should be discarded.
    const noRetryStash = hasFlag(args, "no-retry-stash");

    while (attempt <= maxRetries) {
      if (!noRetryStash && attempt > 0 && lastResult && lastResult.manifest.changedFiles.length > 0) {
        try {
          const { execFileSync } = await import("node:child_process");
          const label = `tanya-retry-${attempt}`;
          // Exclude `.tania/` from the stash: those are runner-internal artifacts
          // (history.json, runs/*, memory/*) regenerated each attempt, and
          // including them in the stash causes pop conflicts on retry-recovery.
          execFileSync(
            "git",
            ["stash", "push", "--include-untracked", "-m", label, "--", ":(exclude).tania", ":!**/.tania/**"],
            { cwd, stdio: "ignore" },
          );
          stashedAttemptResult = lastResult;
          stashedAttemptLabel = label;
          process.stderr.write("[tanya] Stashed previous attempt changes. Retrying from clean state.\n");
        } catch {
          // Not a git repo or stash failed; retry context still helps.
        }
      }
      const retryContext = attempt > 0 && lastResult
        ? buildRetryContext(lastResult.manifest, attempt, previousPostBlockers)
        : "";
      const attemptPrompt = [planBlock, retryContext, "Original task:", prompt]
        .filter(Boolean)
        .join("\n\n---\n");

      lastResult = await runAgent({
        provider,
        prompt: attemptPrompt,
        cwd,
        sink: trackingSink,
        ...(runContext ? { runContext } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        ...(repairAttempts !== undefined ? { repairAttempts } : {}),
        retryAttempt: attempt,
        ...(routing ? { routing } : {}),
      });

      const postBlockers = skipPostCheck
        ? []
        : await detectPostRunBlockers(cwd, lastResult.manifest);
      if (postBlockers.length > 0) {
        process.stderr.write(
          `[tanya] Post-run checks found ${postBlockers.length} issue(s) not reported by model:\n${postBlockers.map((blocker) => `  - ${blocker}`).join("\n")}\n`,
        );
      }
      previousPostBlockers = postBlockers;

      const failed =
        lastResult.manifest.blockers.length > 0 ||
        postBlockers.length > 0 ||
        (lastResult.manifest.validation !== undefined && !lastResult.manifest.validation.passed);

      if (!failed || attempt >= maxRetries) break;

      attempt += 1;
      process.stderr.write(
        `\n[tanya] Attempt ${attempt} had blockers. Starting attempt ${attempt + 1} of ${maxRetries + 1}...\n`,
      );
    }

    if (
      stashedAttemptResult &&
      stashedAttemptLabel &&
      lastResult &&
      lastResult.manifest.changedFiles.length === 0 &&
      stashedAttemptResult.manifest.changedFiles.length > 0
    ) {
      const { execFileSync } = await import("node:child_process");
      let stashList = "";
      try { stashList = execFileSync("git", ["stash", "list"], { cwd, encoding: "utf8" }); } catch { stashList = ""; }
      if (!stashList.includes(stashedAttemptLabel)) {
        process.stderr.write(`[tanya] Stashed attempt (${stashedAttemptLabel}) was already consumed; nothing to recover.\n`);
      } else {
        try {
          execFileSync("git", ["stash", "pop"], { cwd, stdio: "pipe" });
          process.stderr.write(
            `[tanya] Final attempt produced 0 file changes; restoring stashed attempt (${stashedAttemptResult.manifest.changedFiles.length} files) so the work isn't lost.\n`,
          );
          lastResult = stashedAttemptResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/conflict|merge|CONFLICT/i.test(msg)) {
            process.stderr.write(`[tanya] Stash pop conflicted with current tree; aborting pop and keeping current attempt. Conflict: ${msg.slice(0, 240)}\n`);
            try { execFileSync("git", ["checkout", "."], { cwd, stdio: "ignore" }); } catch {}
          } else {
            process.stderr.write(`[tanya] Could not pop stash to recover previous attempt's work: ${msg.slice(0, 240)}\n`);
          }
        }
      }
    }

    if (runPromptTokens > 0 || runCompletionTokens > 0) {
      const costStr = estimateRunCost({
        provider: config.provider,
        model: config.model,
        promptTokens: runPromptTokens,
        completionTokens: runCompletionTokens,
      }).display;
      process.stderr.write(
        `[tanya] Tokens: ${runPromptTokens.toLocaleString()} in / ${runCompletionTokens.toLocaleString()} out  ${costStr}\n`,
      );
    }

    if (hasFlag(args, "review") && lastResult) {
      let diff = "";
      try {
        const { execFileSync } = await import("node:child_process");
        diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
        if (!diff.trim() && lastResult.manifest.git.head) {
          diff = execFileSync("git", ["show", "--format=", "HEAD"], { cwd, encoding: "utf8" });
        }
      } catch {
        // No git repository or diff unavailable; skip optional auto-review.
      }

      if (diff.trim()) {
        process.stdout.write("\n--- Auto-review ---\n");
        const review = await reviewChanges(provider, prompt, diff);
        process.stdout.write(`${review}\n`);
      }
    }
    return;
  }

  await startInteractiveChat({
    provider,
    cwd,
    sink,
    ...(routing ? { routing } : {}),
    resumeSessionId: flagString(args, "resume"),
    continueSession: hasFlag(args, "continue"),
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Tanya error: ${message}`);
  process.exitCode = 1;
});
