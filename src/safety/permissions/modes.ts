import type { PermissionMode } from "./schema";
import type { Decision } from "./engine";

export function modeDefaultDecision(mode: PermissionMode): Decision {
  switch (mode) {
    case "bypass":
      return { decision: "allow", reason: "bypass-mode" };
    case "default":
      return { decision: "allow", reason: "default-mode" };
    case "ask":
      return { decision: "ask", reason: "ask-mode" };
    case "plan":
      return { decision: "deny", reason: "plan-mode" };
  }
}
