import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { captureGitSnapshot } from "../agent/git";
import { buildFinalManifest, ensureCodingReport } from "../agent/report";
import { runAgent, type RunAgentOptions } from "../agent/runner";
import { loadConfig } from "../config/env";
import type { TanyaEvent } from "../events/types";
import { createProvider } from "../providers/factory";
import type { ChatProvider } from "../providers/types";
import { readGoldenTaskMemory } from "../memory/goldenTasks";
import { loadPromptSkillPacks } from "../agent/systemPrompt";

export interface TanyaMcpServerOptions {
  defaultCwd?: string;
  providerFactory?: (cwd: string) => ChatProvider;
  runAgentFn?: (options: RunAgentOptions) => Promise<Awaited<ReturnType<typeof runAgent>>>;
}

export function createTanyaMcpServer(options: TanyaMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "tanya", version: "0.10.0-beta.0" });
  const defaultCwd = () => resolve(options.defaultCwd ?? process.cwd());

  server.registerTool("tanya.verify", {
    description: "Run Tanya's deterministic verifier for a workspace path.",
    inputSchema: {
      path: z.string().optional(),
    },
  }, async (args) => {
    const workspace = resolve(args.path ?? defaultCwd());
    const beforeGitSnapshot = await captureGitSnapshot(workspace);
    const manifest = await buildFinalManifest({
      workspace,
      beforeGitSnapshot,
      changed: [],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [],
      prompt: "MCP tanya.verify",
    });
    const report = ensureCodingReport("", manifest).trim();
    const validationErrors = manifest.validation?.issues.filter((issue) => issue.severity === "error") ?? [];
    const blockers = [...manifest.blockers, ...validationErrors.map((issue) => issue.message)];
    const verdict = blockers.length === 0 ? "passed" : "failed";
    return {
      structuredContent: { verdict, blockers, manifest },
      content: [{ type: "text" as const, text: report || "No verifier evidence available for this workspace." }],
    };
  });

  server.registerTool("tanya.golden_task_search", {
    description: "Search Tanya golden task memory by substring across signature, title, outcome, and blockers.",
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
    },
  }, async (args) => {
    const query = args.query.toLowerCase();
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
    const records = (await readGoldenTaskMemory(defaultCwd()))
      .filter((record) => JSON.stringify({
        signature: record.signature,
        title: record.task?.title,
        kind: record.task?.kind,
        outcome: record.outcome,
        blockers: record.blockers,
      }).toLowerCase().includes(query))
      .slice(-limit)
      .reverse();
    return {
      structuredContent: { records },
      content: [{ type: "text" as const, text: records.length ? JSON.stringify(records, null, 2) : "No matching golden tasks." }],
    };
  });

  server.registerTool("tanya.run", {
    description: "Run a one-shot Tanya agent task.",
    inputSchema: {
      prompt: z.string(),
      cwd: z.string().optional(),
      max_turns: z.number().optional(),
    },
  }, async (args, extra) => {
    const mcpDepth = typeof extra._meta?.["tanya/mcp-depth"] === "number"
      ? extra._meta["tanya/mcp-depth"]
      : 0;
    if (mcpDepth > 1) {
      return {
        isError: true,
        structuredContent: { ok: false, error: "recursive MCP loop detected", depth: mcpDepth },
        content: [{ type: "text" as const, text: "recursive MCP loop detected: Tanya MCP depth > 1" }],
      };
    }
    const cwd = resolve(args.cwd ?? defaultCwd());
    const provider = options.providerFactory ? options.providerFactory(cwd) : createProvider(loadConfig(cwd));
    const events: TanyaEvent[] = [];
    const run = options.runAgentFn ?? runAgent;
    const result = await run({
      provider,
      prompt: args.prompt,
      cwd,
      sink: async (event) => { events.push(event); },
      ...(args.max_turns !== undefined ? { maxTurns: Math.max(1, Math.floor(args.max_turns)) } : {}),
      signal: extra.signal,
    });
    const streamedEvents = events.filter((event) => event.type === "subtask_started" || event.type === "subtask_completed");
    return {
      structuredContent: {
        message: result.message,
        manifest: result.manifest,
        metrics: result.metrics,
        events: streamedEvents,
      },
      content: [{ type: "text" as const, text: result.message }],
    };
  });

  server.registerTool("tanya.skills_list", {
    description: "List Tanya skill packs loaded for a workspace.",
    inputSchema: {
      cwd: z.string().optional(),
    },
  }, async (args) => {
    const cwd = resolve(args.cwd ?? defaultCwd());
    const skills = loadPromptSkillPacks(cwd).map((pack) => ({
      slug: pack.slug,
      title: pack.title,
      sourcePath: pack.sourcePath,
      tokens: pack.tokens,
      reason: pack.reason,
    }));
    return {
      structuredContent: { skills },
      content: [{ type: "text" as const, text: skills.length ? JSON.stringify(skills, null, 2) : "No skill packs loaded." }],
    };
  });

  return server;
}

export async function serveTanyaMcpServer(options: TanyaMcpServerOptions = {}): Promise<void> {
  const server = createTanyaMcpServer(options);
  await server.connect(new StdioServerTransport());
}
