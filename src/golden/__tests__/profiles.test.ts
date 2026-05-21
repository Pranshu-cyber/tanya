import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_GOLDEN_TASK_PROFILES, loadGoldenTaskProfiles } from "../profiles";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-golden-integrations-"));
  tempRoots.push(root);
  return root;
}

function write(root: string, path: string, content: unknown): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("golden profile integrations", () => {
  it("returns built-in profiles unchanged when integrations are absent", () => {
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", join(makeTempRoot(), "missing"));

    expect(loadGoldenTaskProfiles()).toEqual(BUILT_IN_GOLDEN_TASK_PROFILES);
  });

  it("merges discovered golden profile JSON after built-ins", () => {
    const root = makeTempRoot();
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", root);
    write(root, "acme/golden/profiles.json", {
      profiles: [
        {
          id: "acme.profile.smoke",
          title: "Acme Smoke",
          platform: "cross-platform",
          purpose: "Verify integration profile discovery.",
          requiredCapabilities: ["profile discovery"],
        },
      ],
    });

    expect(loadGoldenTaskProfiles()).toEqual([
      ...BUILT_IN_GOLDEN_TASK_PROFILES,
      {
        id: "acme.profile.smoke",
        title: "Acme Smoke",
        platform: "cross-platform",
        purpose: "Verify integration profile discovery.",
        requiredCapabilities: ["profile discovery"],
      },
    ]);
  });
});
