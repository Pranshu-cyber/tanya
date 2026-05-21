import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

export function resolveWorkspace(cwd: string): string {
  return realpathSync(resolve(cwd));
}

export function pathIsInsideWorkspace(workspace: string, inputPath: string): boolean {
  const target = resolve(workspace, inputPath);
  const lexicalRel = relative(workspace, target);
  return !(lexicalRel.startsWith("..") || lexicalRel === ".." || lexicalRel.includes(`..${"/"}`));
}

export function resolveInsideWorkspace(workspace: string, inputPath: string): string {
  const target = resolve(workspace, inputPath);
  const lexicalRel = relative(workspace, target);
  if (lexicalRel.startsWith("..") || lexicalRel === ".." || lexicalRel.includes(`..${"/"}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  if (!existsSync(workspace)) return target;
  const realWorkspace = realpathSync(workspace);
  let existingPath = target;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
  }

  if (existsSync(existingPath)) {
    const realExisting = realpathSync(existingPath);
    const realRel = relative(realWorkspace, realExisting);
    if (realRel.startsWith("..") || realRel === ".." || realRel.includes(`..${"/"}`)) {
      throw new Error(`Path escapes workspace via symlink: ${inputPath}`);
    }
    if (lstatSync(existingPath).isSymbolicLink()) {
      const symlinkRel = relative(realWorkspace, realExisting);
      if (symlinkRel.startsWith("..") || symlinkRel === ".." || symlinkRel.includes(`..${"/"}`)) {
        throw new Error(`Path escapes workspace via symlink: ${inputPath}`);
      }
    }
  }
  return target;
}
