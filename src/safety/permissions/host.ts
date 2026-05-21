export interface PermissionRequest {
  id: string;
  tool: string;
  input: unknown;
  matchedRule?: string;
  projectedCostUsd?: number;
  projectedTokens?: number;
}

export interface HostPermissionAnswer {
  decision: "allow" | "deny";
  persistAs?: "always" | "never";
}

export type PermissionRequestHandler = (request: PermissionRequest) => Promise<HostPermissionAnswer>;
