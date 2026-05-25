import type { EvalSuite, EvalTask } from "../schemas";

export const SWE_BENCH_LITE_REPO = "https://github.com/SWE-bench/SWE-bench.git";
export const SWE_BENCH_LITE_COMMIT = "f7bbbb2ccdf479001d6467c9e34af59e44a840f9";

export function sweBenchLiteSuite(): EvalSuite {
  const tasks: EvalTask[] = Array.from({ length: 30 }, (_, index) => ({
    id: `swe-lite-${String(index + 1).padStart(2, "0")}`,
    repo_setup: {
      type: "git_clone",
      url: SWE_BENCH_LITE_REPO,
      commit: SWE_BENCH_LITE_COMMIT,
      path: `.tanya/eval/datasets/swe-bench-lite/${String(index + 1).padStart(2, "0")}`,
    },
    prompt: `Run the pinned SWE-bench-Lite task ${index + 1} through Tanya's verifier-aware workflow.`,
    metadata: {
      dataset: "SWE-bench-Lite",
      pinnedCommit: SWE_BENCH_LITE_COMMIT,
      cacheDir: ".tanya/eval/datasets/swe-bench-lite",
    },
  }));
  return { name: "swe-bench-lite", version: `pinned-${SWE_BENCH_LITE_COMMIT.slice(0, 12)}`, tasks };
}
