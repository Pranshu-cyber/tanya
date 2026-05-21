import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { TanyaRunContext } from "../context/runContext";
import type { ChatMessage } from "../providers/types";
import type { PermissionContext } from "../safety/permissions/engine";
import type { PermissionRulesConfig, SpendRule } from "../safety/permissions/schema";

export type SubAgentTokenBudget = {
  max_usd?: number;
  max_tokens?: number;
  expectedSiblings?: number;
};

export type RunAgentParentContext = {
  runId: string;
  workspace: string;
  permissionContext: PermissionContext;
  runContext?: TanyaRunContext;
  history?: ChatMessage[];
  childIndex?: number;
  tokenBudget?: SubAgentTokenBudget;
};

export function createRootRunId(now: Date = new Date()): string {
  return `r-${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function childRunId(parentRunId: string, childIndex: number): string {
  return `${parentRunId}.t-${Math.max(1, Math.floor(childIndex))}`;
}

export function runIdDepth(runId: string): number {
  return Math.max(0, runId.split(".").length - 1);
}

export function resolveSubAgentWorkspace(parentWorkspace: string, requestedWorkspace?: string): string {
  const target = resolve(parentWorkspace, requestedWorkspace ?? ".");
  const lexicalRel = relative(parentWorkspace, target);
  if (lexicalRel.startsWith("..") || lexicalRel === "..") {
    throw new Error(`Sub-agent workspace escapes parent workspace: ${requestedWorkspace ?? target}`);
  }
  if (!existsSync(target)) return target;
  const realParent = realpathSync(parentWorkspace);
  const realTarget = realpathSync(target);
  const realRel = relative(realParent, realTarget);
  if (realRel.startsWith("..") || realRel === "..") {
    throw new Error(`Sub-agent workspace escapes parent workspace via symlink: ${requestedWorkspace ?? target}`);
  }
  return realTarget;
}

export function mergeRunContexts(parent?: TanyaRunContext, child?: TanyaRunContext): TanyaRunContext | undefined {
  if (!parent) return child;
  if (!child) return cloneRunContext(parent);
  const merged: TanyaRunContext = {};
  if (parent.task || child.task) merged.task = { ...(parent.task ?? {}), ...(child.task ?? {}) };
  const artifacts = mergeObjectLists(parent.artifacts, child.artifacts, "path");
  if (artifacts) merged.artifacts = artifacts;
  const contextFiles = mergeObjectLists(parent.contextFiles, child.contextFiles, "path");
  if (contextFiles) merged.contextFiles = contextFiles;
  const instructions = unique([...(parent.instructions ?? []), ...(child.instructions ?? [])]);
  if (instructions) merged.instructions = instructions;
  const verificationCommands = unique([...(parent.verification?.commands ?? []), ...(child.verification?.commands ?? [])]);
  if (verificationCommands) merged.verification = { commands: verificationCommands };
  const languages = unique([...(parent.languages ?? []), ...(child.languages ?? [])]);
  if (languages) merged.languages = languages;
  const frameworks = unique([...(parent.frameworks ?? []), ...(child.frameworks ?? [])]);
  if (frameworks) merged.frameworks = frameworks;
  const stack = child.stack ?? parent.stack;
  if (stack) merged.stack = stack;
  const expectedReport = child.expected_report ?? parent.expected_report;
  if (expectedReport) merged.expected_report = expectedReport;
  const metadata = { ...(parent.metadata ?? {}), ...(child.metadata ?? {}) };
  if (Object.keys(metadata).length > 0) merged.metadata = metadata;
  return merged;
}

export function applyTokenBudgetRule(rules: PermissionRulesConfig, budget?: SubAgentTokenBudget): PermissionRulesConfig {
  if (!budget || (budget.max_tokens === undefined && budget.max_usd === undefined)) return rules;
  const spendRule: SpendRule = {
    type: "spend",
    scope: "session",
    ...(budget.max_usd !== undefined ? { max_usd: budget.max_usd } : {}),
    ...(budget.max_tokens !== undefined ? { max_tokens: budget.max_tokens } : {}),
    action: "deny",
  };
  return {
    ...rules,
    spendRules: [...rules.spendRules, spendRule],
  };
}

function cloneRunContext(context: TanyaRunContext): TanyaRunContext {
  return {
    ...(context.task ? { task: { ...context.task } } : {}),
    ...(context.artifacts ? { artifacts: context.artifacts.map((item) => ({ ...item })) } : {}),
    ...(context.contextFiles ? { contextFiles: context.contextFiles.map((item) => ({ ...item })) } : {}),
    ...(context.instructions ? { instructions: [...context.instructions] } : {}),
    ...(context.verification ? { verification: { commands: [...(context.verification.commands ?? [])] } } : {}),
    ...(context.languages ? { languages: [...context.languages] } : {}),
    ...(context.frameworks ? { frameworks: [...context.frameworks] } : {}),
    ...(context.stack ? { stack: context.stack } : {}),
    ...(context.expected_report ? { expected_report: { ...context.expected_report } } : {}),
    ...(context.metadata ? { metadata: { ...context.metadata } } : {}),
  };
}

function mergeObjectLists<T extends Record<string, unknown>>(parent: T[] | undefined, child: T[] | undefined, key: keyof T): T[] | undefined {
  const merged = new Map<unknown, T>();
  for (const item of parent ?? []) merged.set(item[key], { ...item });
  for (const item of child ?? []) merged.set(item[key], { ...merged.get(item[key]), ...item });
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function unique(values: string[]): string[] | undefined {
  const result = [...new Set(values.filter((value) => value.trim().length > 0))];
  return result.length > 0 ? result : undefined;
}
