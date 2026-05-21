import { buildGoldenTaskSummary, readGoldenTaskMemory, validateGoldenTaskSummary } from "../memory/goldenTasks";
import { BUILT_IN_GOLDEN_TASK_PROFILES, loadGoldenTaskProfiles } from "./profiles";
import { goldenRunnableProfiles, runGoldenTask } from "./run";

export async function runGoldenSuiteCommand(workspace: string, action: string, json = false, options: { profile?: string; all?: boolean } = {}): Promise<number> {
  const records = await readGoldenTaskMemory(workspace);
  const summary = buildGoldenTaskSummary(records);
  const problems = validateGoldenTaskSummary(summary);

  if (action === "run") {
    const profiles = options.all
      ? goldenRunnableProfiles()
      : [options.profile ?? "tanya.low.search-replace"]
        .map((profileId) => loadGoldenTaskProfiles().find((profile) => profile.id === profileId))
        .filter((profile): profile is NonNullable<typeof profile> => !!profile);
    if (profiles.length === 0) {
      const message = `No executable golden profile matched ${options.profile ?? "(default)"}.`;
      if (json) console.log(JSON.stringify({ results: [], problems: [message] }, null, 2));
      else console.log(message);
      return 1;
    }
    const results = [];
    for (const profile of profiles) results.push(await runGoldenTask(profile.id));
    if (json) {
      console.log(JSON.stringify({
        results: results.map((result) => ({
          profileId: result.profile.id,
          title: result.profile.title,
          workspace: result.workspace,
          passed: result.passed,
          problems: result.problems,
        })),
      }, null, 2));
    } else {
      for (const result of results) {
        console.log(`${result.passed ? "PASS" : "FAIL"} ${result.profile.id} ${result.profile.title}`);
        console.log(`  workspace: ${result.workspace}`);
        if (result.problems.length > 0) console.log(`  problems: ${result.problems.join(", ")}`);
      }
    }
    return results.every((result) => result.passed) ? 0 : 1;
  }

  if (json) {
    const profiles = loadGoldenTaskProfiles();
    console.log(JSON.stringify({
      summary,
      problems,
      profiles: action === "profiles" ? profiles : undefined,
      executableProfiles: action === "profiles" ? goldenRunnableProfiles().map((profile) => profile.id) : undefined,
    }, null, 2));
    return action === "validate" && problems.length > 0 ? 1 : 0;
  }

  if (action === "profiles") {
    const profiles = loadGoldenTaskProfiles();
    if (profiles.length === BUILT_IN_GOLDEN_TASK_PROFILES.length) {
      console.log(`Built-in golden task profiles: ${BUILT_IN_GOLDEN_TASK_PROFILES.length}`);
    } else {
      console.log(`Golden task profiles: ${profiles.length} (${BUILT_IN_GOLDEN_TASK_PROFILES.length} built-in, ${profiles.length - BUILT_IN_GOLDEN_TASK_PROFILES.length} integration)`);
    }
    const runnable = goldenRunnableProfiles();
    for (const profile of profiles) {
      const executable = runnable.some((item) => item.id === profile.id) ? " executable" : "";
      console.log(`${profile.id} [${profile.platform}${executable}] ${profile.title}`);
      console.log(`  ${profile.purpose}`);
      console.log(`  capabilities: ${profile.requiredCapabilities.join(", ")}`);
    }
    return 0;
  }

  if (action === "list") {
    if (summary.latestBySignature.length === 0) {
      console.log("No golden task records found.");
      return 0;
    }
    for (const record of summary.latestBySignature) {
      const title = record.task?.title ?? record.signature;
      console.log(`${record.outcome.toUpperCase()} ${record.signature} ${title}`);
    }
    return 0;
  }

  console.log(`Golden tasks: ${summary.total} record(s), ${summary.signatures} signature(s), ${summary.passed} passed, ${summary.failed} failed.`);
  if (summary.failureReasons.length > 0) {
    console.log("Top failure reasons:");
    for (const reason of summary.failureReasons.slice(0, 8)) console.log(`- ${reason.reason}: ${reason.count}`);
  }
  if (action === "validate") {
    if (problems.length === 0) {
      console.log("Golden suite validation passed.");
      return 0;
    }
    console.log("Golden suite validation failed:");
    for (const problem of problems) console.log(`- ${problem}`);
    return 1;
  }
  return 0;
}
