import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverIntegrationEntries, integrationsRoot } from "../discovery";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tanya-integrations-"));
}

function write(root: string, path: string, content = ""): string {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

describe("integration discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns no entries when the integrations root is absent", () => {
    const root = join(makeTempRoot(), "missing");

    expect(discoverIntegrationEntries("skills", { root })).toEqual([]);
  });

  it("discovers entries under multiple integrations", () => {
    const root = makeTempRoot();
    const android = write(root, "cosmohq/skills/android-cosmohq.md");
    const profile = write(root, "acme/skills/profile.md");
    const directory = join(root, "acme", "skills", "nested-pack");
    mkdirSync(directory, { recursive: true });

    expect(discoverIntegrationEntries("skills", { root })).toEqual([
      { integration: "acme", kind: "skills", path: directory },
      { integration: "acme", kind: "skills", path: profile },
      { integration: "cosmohq", kind: "skills", path: android },
    ]);
  });

  it("respects the TANYA_INTEGRATIONS_DIR override", () => {
    const root = makeTempRoot();
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", root);

    expect(integrationsRoot()).toBe(root);
  });

  it("supports the legacy TANIA_INTEGRATIONS_DIR override", () => {
    const root = makeTempRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const currentOverride = process.env.TANYA_INTEGRATIONS_DIR;
    delete process.env.TANYA_INTEGRATIONS_DIR;

    try {
      expect(integrationsRoot({ TANIA_INTEGRATIONS_DIR: root })).toBe(root);
      expect(warn).toHaveBeenCalledWith("[tanya] TANIA_INTEGRATIONS_DIR is deprecated; use TANYA_INTEGRATIONS_DIR.");
    } finally {
      if (currentOverride === undefined) delete process.env.TANYA_INTEGRATIONS_DIR;
      else process.env.TANYA_INTEGRATIONS_DIR = currentOverride;
    }
  });

  it("skips integrations that are missing the requested kind", () => {
    const root = makeTempRoot();
    write(root, "cosmohq/suites/main.json");
    const validator = write(root, "acme/validators/rules.json");

    expect(discoverIntegrationEntries("validators", { root })).toEqual([
      { integration: "acme", kind: "validators", path: validator },
    ]);
  });
});
