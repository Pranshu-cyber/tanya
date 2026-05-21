export interface SkillPackContext {
  workspace: string;
  hints: {
    languages?: string[];
    frameworks?: string[];
    stack?: string;
  };
  taskHint?: string;
}
export interface SkillPackFrontmatter {
  slug: string;
  loadWhen: Array<
    | { kind: "always" }
    | { kind: "workspace.has"; path: string }
    | { kind: "workspace.hasGlob"; glob: string }
    | { kind: "workspace.packageJson"; dep: string }
    | { kind: "hint.language"; value: string }
    | { kind: "hint.framework"; value: string }
    | { kind: "hint.stack"; value: string }
  >;
  sizeTarget: number;  // tokens, advisory
  priority: number;    // 0=highest (failure-modes), 10=lowest
}
export interface LoadedSkillPack {
  slug: string;
  title: string;
  sourcePath: string;
  content: string;   // markdown body, frontmatter stripped
  tokens: number;    // chars/4 estimate
  reason: "always" | "workspace" | "hint";
}
