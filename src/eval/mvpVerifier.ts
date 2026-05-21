import { access, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MvpVerifierOutcome =
  | { ok: true; notes: string[] }
  | { ok: false; errors: string[] };

type CommandResult = {
  code: number;
  output: string;
};

export async function runMvpVerifier(taskId: string, workspace: string, repoRoot: string): Promise<MvpVerifierOutcome | null> {
  if (taskId === "mvp-02") return verifyExpressNotesApi(workspace);
  if (taskId === "mvp-03") return verifyHnScraper(workspace);
  if (taskId === "mvp-10") return verifyCommanderCli(workspace, repoRoot);
  return null;
}

async function verifyHnScraper(workspace: string): Promise<MvpVerifierOutcome> {
  const errors: string[] = [];
  for (const file of ["hn_top.py", "requirements.txt", "README.md", "stories.json"]) {
    if (!existsSync(join(workspace, file))) errors.push(`${file} is missing.`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const requirements = await readFile(join(workspace, "requirements.txt"), "utf8");
  if (!/\brequests\b/i.test(requirements)) errors.push("requirements.txt must include requests.");
  if (!/\b(?:beautifulsoup4|bs4)\b/i.test(requirements)) errors.push("requirements.txt must include beautifulsoup4.");

  const readme = await readFile(join(workspace, "README.md"), "utf8");
  if (!/\b(?:mock|fallback|sample|offline|network unavailable|network limitation)\b/i.test(readme)) {
    errors.push("README.md must document mock/offline fallback behavior for unavailable live network access.");
  }

  try {
    const parsed = JSON.parse(await readFile(join(workspace, "stories.json"), "utf8")) as unknown;
    const stories = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { stories?: unknown }).stories)
        ? (parsed as { stories: unknown[] }).stories
        : null;
    if (!stories) errors.push("stories.json must be an array or an object with a stories array.");
    else {
      if (stories.length > 10) errors.push("stories.json must contain at most 10 stories.");
      if (stories.length === 0) errors.push("stories.json should include deterministic sample stories when live network access is unavailable.");
      if (!stories.every((story) => story && typeof story === "object" && typeof (story as { title?: unknown }).title === "string")) {
        errors.push("Each story must include a title.");
      }
    }
  } catch (error) {
    errors.push(`stories.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, notes: ["HN scraper fallback artifact verified."] };
}

async function verifyExpressNotesApi(workspace: string): Promise<MvpVerifierOutcome> {
  const candidates = ["src/server.js", "src/index.js", "server.js", "app.js"]
    .filter((file) => existsSync(join(workspace, file)));
  if (candidates.length === 0) {
    return { ok: false, errors: ["No Express entry file found. Expected src/server.js, src/index.js, server.js, or app.js."] };
  }

  const script = String.raw`
const { existsSync } = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const entries = ${JSON.stringify(candidates)};

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assertStatus(response, accepted, label) {
  if (!accepted.includes(response.status)) {
    throw new Error(label + " returned HTTP " + response.status + " with body " + response.body);
  }
}

async function testRoutes(port) {
  assertStatus(await request(port, "GET", "/notes"), [200], "GET /notes");
  const created = await request(port, "POST", "/notes", { title: "test", content: "hello" });
  assertStatus(created, [200, 201], "POST /notes");
  let id = 1;
  try {
    const parsed = JSON.parse(created.body);
    id = parsed.id ?? parsed.note?.id ?? parsed.data?.id ?? 1;
  } catch {}
  assertStatus(await request(port, "GET", "/notes"), [200], "GET /notes after create");
  assertStatus(await request(port, "PUT", "/notes/" + encodeURIComponent(String(id)), { title: "test", content: "world" }), [200, 204], "PUT /notes/:id");
  assertStatus(await request(port, "DELETE", "/notes/" + encodeURIComponent(String(id))), [200, 202, 204], "DELETE /notes/:id");
}

async function loadModule(entry) {
  try {
    return require("./" + entry);
  } catch (err) {
    if (!/(ERR_REQUIRE_ESM|Cannot use import statement|Unexpected token 'export')/.test(String(err && (err.stack || err.message || err)))) throw err;
    return import(pathToFileURL(process.cwd() + "/" + entry).href);
  }
}

async function verifyExportShape(entry) {
  const loaded = await loadModule(entry);
  const candidates = [
    loaded,
    loaded && loaded.default,
    loaded && loaded.app,
    loaded && loaded.server,
    loaded && typeof loaded.createApp === "function" ? loaded.createApp() : null,
  ].filter(Boolean);
  for (const app of candidates) {
    if (typeof app.listen !== "function") continue;
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await testRoutes(port);
      return "export:" + entry;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  throw new Error("No exported Express app with .listen() found in " + entry);
}

async function waitForServer(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await request(port, "GET", "/notes");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for server on port " + port);
}

async function verifyScriptShape(entry) {
  const port = 3101;
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
      await waitForServer(port, 1500);
    await testRoutes(port);
    return "script:" + entry;
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500).unref();
  }
}

(async () => {
  const errors = [];
  for (const entry of entries) {
    try {
      const via = await verifyExportShape(entry);
      console.log("verified " + via);
      return;
    } catch (err) {
      errors.push(entry + " export shape: " + (err && err.message ? err.message : String(err)));
    }
  }
  for (const entry of entries) {
    try {
      const via = await verifyScriptShape(entry);
      console.log("verified " + via);
      return;
    } catch (err) {
      errors.push(entry + " script shape: " + (err && err.message ? err.message : String(err)));
    }
  }
  console.error(errors.join("\n"));
  process.exit(1);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

  const result = await runNodeScript(workspace, script, 20_000);
  if (result.code === 0) return { ok: true, notes: [result.output.trim() || "Express routes verified."] };
  return { ok: false, errors: [`Express route verification failed: ${result.output}`] };
}

async function verifyCommanderCli(workspace: string, repoRoot: string): Promise<MvpVerifierOutcome> {
  const packageJsonPath = join(workspace, "package.json");
  if (!existsSync(packageJsonPath)) return { ok: false, errors: ["package.json is missing."] };
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const source = existsSync(join(workspace, "src", "index.ts"))
    ? await readFile(join(workspace, "src", "index.ts"), "utf8")
    : "";
  const hasCommander = Boolean(packageJson.dependencies?.commander || packageJson.devDependencies?.commander || /\bfrom\s+["']commander["']|\brequire\(["']commander["']\)/.test(source));
  if (!hasCommander) return { ok: false, errors: ["Commander dependency/import was not found."] };

  if (packageJson.scripts?.build) {
    await runCommand(workspace, "npm", ["run", "build"], 90_000).catch(() => undefined);
  }

  const command = await resolveCliCommand(workspace, repoRoot, packageJson);
  if (!command) {
    return { ok: false, errors: ["No runnable CLI entry found. Expected dist/index.js, src/index.ts, src/index.js, or package.json bin."] };
  }

  const nodePath = [join(repoRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":");
  const env = nodePath ? { NODE_PATH: nodePath } : {};

  await rm(join(workspace, ".mvp10"), { recursive: true, force: true }).catch(() => undefined);

  const errors: string[] = [];
  const init = await runCommand(workspace, command.cmd, [...command.args, "init"], 20_000, env);
  if (init.code !== 0) errors.push(`init failed: ${init.output}`);
  const add = await runCommand(workspace, command.cmd, [...command.args, "add", "Buy milk"], 20_000, env);
  if (add.code !== 0) errors.push(`add failed: ${add.output}`);
  const list = await runCommand(workspace, command.cmd, [...command.args, "list"], 20_000, env);
  if (list.code !== 0 || !/Buy milk/i.test(list.output)) errors.push(`list did not show persisted item: ${list.output}`);
  const itemId = itemIdFromListOutput(list.output, "Buy milk") ?? "1";
  const remove = await runCommand(workspace, command.cmd, [...command.args, "remove", itemId], 20_000, env);
  if (remove.code !== 0) errors.push(`remove existing item failed: ${remove.output}`);
  const missingRemove = await runCommand(workspace, command.cmd, [...command.args, "remove", "99"], 20_000, env);
  if (missingRemove.code !== 0 && !/\b(not found|no item|missing|does not exist|unknown id|invalid id)\b/i.test(missingRemove.output)) {
    errors.push(`remove missing id failed without a clear negative-path message: ${missingRemove.output}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, notes: [`Commander CLI verified via ${command.cmd} ${command.args.join(" ")}`.trim()] };
}

function itemIdFromListOutput(output: string, itemLabel: string): string | null {
  const escapedLabel = itemLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const line of output.split(/\r?\n/)) {
    if (!new RegExp(escapedLabel, "i").test(line)) continue;
    const direct = line.match(/\b(?:id|#)\s*[:=]?\s*([A-Za-z0-9_-]{1,36})\b/i)?.[1];
    if (direct) return direct;
    const leading = line.match(/^\s*(?:[-*]\s*)?([A-Za-z0-9_-]{1,36})\s*(?:[).:-]|\s+-\s+)/)?.[1];
    if (leading) return leading;
  }
  return null;
}

async function resolveCliCommand(
  workspace: string,
  repoRoot: string,
  packageJson: { bin?: string | Record<string, string> },
): Promise<{ cmd: string; args: string[] } | null> {
  const binValue = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin ? Object.values(packageJson.bin)[0] : undefined;
  const candidates = [
    binValue,
    "dist/index.js",
    "dist/cli.js",
    "src/index.js",
  ].filter((entry): entry is string => Boolean(entry));
  for (const entry of candidates) {
    if (existsSync(join(workspace, entry))) return { cmd: process.execPath, args: [entry] };
  }
  const tsEntry = join(workspace, "src", "index.ts");
  if (existsSync(tsEntry)) {
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    await access(tsxCli);
    return { cmd: process.execPath, args: [tsxCli, "src/index.ts"] };
  }
  return null;
}

async function runNodeScript(cwd: string, script: string, timeoutMs: number): Promise<CommandResult> {
  return runCommand(cwd, process.execPath, ["-e", script], timeoutMs);
}

async function runCommand(cwd: string, command: string, args: string[], timeoutMs: number, envOverrides: Record<string, string> = {}): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...envOverrides },
    });
    return { code: 0, output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ? `\n${err.stderr}` : ""}`.trim() || err.message || "command failed";
    return { code: typeof err.code === "number" ? err.code : 1, output };
  }
}
