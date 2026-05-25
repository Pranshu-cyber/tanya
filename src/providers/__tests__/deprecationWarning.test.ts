import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerOptions = {
  id: "deepseek",
  apiKey: "test",
  baseUrl: "https://api.deepseek.com",
};

async function instantiate(model: string) {
  const { OpenAiCompatibleProvider } = await import("../openAiCompatible");
  return new OpenAiCompatibleProvider({ ...providerOptions, model });
}

describe("DeepSeek legacy model deprecation warning", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("warns on stderr when deepseek-chat is used", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await instantiate("deepseek-chat");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('DeepSeek model "deepseek-chat"');
    expect(String(stderr.mock.calls[0]?.[0])).toContain("docs/providers.md#deepseek-v4-deprecation");
  });

  it("warns only once per process for the same legacy model", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await instantiate("deepseek-reasoner");
    await instantiate("deepseek-reasoner");

    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("does not warn for the canonical V4 model name", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await instantiate("deepseek-v4-flash");

    expect(stderr).not.toHaveBeenCalled();
  });

  it("suppresses the warning with TANYA_SUPPRESS_DEPRECATION=1", async () => {
    vi.stubEnv("TANYA_SUPPRESS_DEPRECATION", "1");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await instantiate("deepseek-chat");

    expect(stderr).not.toHaveBeenCalled();
  });

});
