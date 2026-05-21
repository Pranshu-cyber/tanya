import type { Verifier } from "./types";
import { goBackendVerifier } from "./verifiers/goBackend";
import { nodeBackendVerifier } from "./verifiers/nodeBackend";
import { frontendVerifier } from "./verifiers/frontend";
import { iosVerifier, androidVerifier } from "./verifiers/mobile";

export const builtinVerifiers: Verifier[] = [
  goBackendVerifier,
  nodeBackendVerifier,
  frontendVerifier,
  iosVerifier,
  androidVerifier,
];
