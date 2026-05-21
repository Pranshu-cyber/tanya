import { join } from "node:path";
import type { Verifier, VerifierCheck, VerifierContext } from "../types";
import { makeCheck } from "../types";

const BACKEND_DEP_HINTS = ["express", "fastify", "@nestjs/core", "hono", "koa", "@fastify/", "@hono/"];

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(ctx: VerifierContext): PackageJson | null {
  const text = ctx.readText(join(ctx.workspace, "package.json"));
  if (!text) return null;
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

function looksLikeBackend(pkg: PackageJson): boolean {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return BACKEND_DEP_HINTS.some((hint) => Object.keys(deps).some((k) => k === hint || k.startsWith(hint)));
}

export const nodeBackendVerifier: Verifier = {
  id: "node-backend",
  platform: "node-backend",
  appliesTo(ctx) {
    const pkg = readPackageJson(ctx);
    if (!pkg) return false;
    return looksLikeBackend(pkg);
  },
  async run(ctx) {
    const checks: VerifierCheck[] = [];
    const pkg = readPackageJson(ctx);
    checks.push(makeCheck({
      id: "package-json-parse",
      description: "package.json parses",
      passed: pkg !== null,
      authoritative: false,
      error: pkg === null ? "package.json missing or unparseable" : undefined,
    }));
    if (!pkg) return checks;

    const scripts = pkg.scripts ?? {};
    if (typeof scripts.typecheck === "string") {
      const res = await ctx.shell(ctx.workspace, "npm", ["run", "--silent", "typecheck"], { timeoutMs: 180_000 });
      if (res.binaryMissing) return checks;
      const passed = res.exit === 0;
      checks.push(makeCheck({
        id: "npm-typecheck",
        description: "npm run typecheck",
        passed,
        authoritative: true,
        error: passed ? undefined : (res.stderr || res.stdout || "typecheck failed").slice(0, 500),
      }));
    }
    if (typeof scripts.test === "string" && !/no test specified/i.test(scripts.test)) {
      const res = await ctx.shell(ctx.workspace, "npm", ["test", "--silent"], { timeoutMs: 240_000 });
      if (res.binaryMissing) return checks;
      const passed = res.exit === 0;
      checks.push(makeCheck({
        id: "npm-test",
        description: "npm test",
        passed,
        authoritative: true,
        error: passed ? undefined : (res.stderr || res.stdout || "tests failed").slice(0, 500),
      }));
    }
    return checks;
  },
};
