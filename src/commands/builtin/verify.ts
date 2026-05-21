import { buildFinalManifest, ensureCodingReport } from "../../agent/report";
import { captureGitSnapshot } from "../../agent/git";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const verifyCommand: CommandDefinition = {
  name: "verify",
  description: "Run Tanya's deterministic final-state verifier for the current workspace.",
  category: "built-in",
  async handler(_args, ctx) {
    const beforeGitSnapshot = await captureGitSnapshot(ctx.cwd);
    const manifest = await buildFinalManifest({
      workspace: ctx.cwd,
      beforeGitSnapshot,
      changed: [],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [],
      prompt: "Ad-hoc /verify command",
    });
    const report = ensureCodingReport("", manifest);
    ctx.output.write(`${report.trim() || "No verifier evidence available for this workspace."}\n`);
  },
};

registerCommand(verifyCommand);
