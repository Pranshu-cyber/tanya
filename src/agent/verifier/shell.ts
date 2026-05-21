import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerifierShell, VerifierShellResult } from "./types";

const execFileAsync = promisify(execFile);

export const noopShell: VerifierShell = async () => ({
  exit: 1,
  stdout: "",
  stderr: "noop shell",
  binaryMissing: true,
});

export const realShell: VerifierShell = async (cwd, command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: options?.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: options?.env ?? process.env,
    });
    return { exit: 0, stdout, stderr };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
    const timedOut = error.killed === true || error.signal === "SIGTERM";
    const binaryMissing = error.code === "ENOENT";
    const result: VerifierShellResult = {
      exit: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
    };
    if (timedOut) result.timedOut = true;
    if (binaryMissing) result.binaryMissing = true;
    return result;
  }
};
