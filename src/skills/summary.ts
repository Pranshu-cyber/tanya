import type { LoadedSkillPack } from "./types";
import { SKILL_PACK_TOKEN_BUDGET } from "./load";

export function formatSkillPackSummary(packs: LoadedSkillPack[]): string {
  const totalTokens = packs.reduce((sum, pack) => sum + pack.tokens, 0);
  const lines = [
    `Skill packs loaded: ${packs.length}`,
    "| slug | source | reason | tokens |",
    "|------|--------|--------|--------|",
    ...packs.map((pack) => `| ${pack.slug} | ${pack.sourcePath} | ${pack.reason} | ${pack.tokens} |`),
    `Total pack tokens: ${totalTokens} / ${SKILL_PACK_TOKEN_BUDGET}`,
  ];
  return lines.join("\n");
}
