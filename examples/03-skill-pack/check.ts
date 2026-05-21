import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillPacksFromRoot } from "../../src/skills/load";

const exampleRoot = fileURLToPath(new URL(".", import.meta.url));
const workspace = join(exampleRoot, "workspace");
const skillsRoot = join(exampleRoot, "skills");

const packs = loadSkillPacksFromRoot({
  workspace,
  hints: { frameworks: ["example"] },
}, skillsRoot);

const slugs = packs.map((pack) => pack.slug);
if (!slugs.includes("framework/example")) {
  throw new Error(`Expected framework/example, got: ${slugs.join(", ") || "(none)"}`);
}

console.log(slugs.join("\n"));
