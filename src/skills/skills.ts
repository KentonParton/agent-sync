import { posix } from "node:path";
import { parseDocument } from "yaml";
import {
  nameSchema,
  type Harness,
  type Manifest,
} from "../manifest/manifest.js";
import type {
  FileTree,
  Provenance,
  SourceResolver,
} from "../sources/source.js";
import type { OutputPlan } from "../sync/plan.js";
const directories: Record<Harness, string> = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
};
export function skillLocations(): string[] {
  return Object.values(directories);
}
export function installSkill(
  name: string,
  files: FileTree,
  targets: Harness[],
  provenance: Provenance,
  plan: OutputPlan,
) {
  nameSchema.parse(name);
  const skill = files.get("SKILL.md");
  if (!skill) throw new Error(`Skill ${name} has no SKILL.md`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    skill.content.toString("utf8"),
  );
  if (!frontmatter)
    throw new Error(
      `Skill ${name} needs YAML frontmatter with name and description`,
    );
  const doc = parseDocument(frontmatter[1]!);
  if (doc.errors.length) throw new Error(`Invalid skill frontmatter: ${name}`);
  const metadata = doc.toJS({ maxAliasCount: 50 });
  if (
    !metadata ||
    typeof metadata.name !== "string" ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim()
  )
    throw new Error(`Skill ${name} needs name and description`);
  nameSchema.parse(metadata.name);
  const projected = new Map(files);
  projected.set("SKILL.md", {
    ...skill,
    content: renameSkill(skill.content, name),
  });
  for (const target of targets)
    plan.tree(`${directories[target]}/${name}`, projected, "skill", provenance);
}
export function selectDirectories(
  tree: FileTree,
  marker: string,
  include?: string[],
): Map<string, FileTree> {
  const found = new Map<string, FileTree>();
  for (const path of tree.keys()) {
    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === marker)
      found.set(parts[0]!, new Map());
  }
  for (const name of include ?? found.keys()) {
    if (!found.has(name))
      throw new Error(`Selected resource ${name} is missing ${marker}`);
  }
  const selected = new Map(
    [...found].filter(([name]) => !include || include.includes(name)),
  );
  for (const [path, file] of tree) {
    const [name, ...rest] = path.split("/");
    selected.get(name!)?.set(rest.join("/"), file);
  }
  return selected;
}
export async function composeSkills(
  manifest: Manifest,
  sources: SourceResolver,
  plan: OutputPlan,
) {
  for (const spec of manifest.skills) {
    const source = await sources.resolve(spec);
    const skills = selectDirectories(
      await source.tree(spec.path),
      "SKILL.md",
      spec.include,
    );
    for (const [name, tree] of skills)
      installSkill(
        name,
        tree,
        manifest.targets,
        source.provenance(posix.join(spec.path, name)),
        plan,
      );
  }
}

function renameSkill(content: Buffer, name: string): Buffer {
  const text = content.toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Skill frontmatter is missing");
  const doc = parseDocument(match[1]!);
  if (doc.errors.length) throw new Error("Invalid skill frontmatter");
  if (doc.get("name") === name) return content;
  doc.set("name", name);
  return Buffer.from(
    `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
  );
}
/** Reconcile a projected skill name with its source before preparing a contribution. */
export function restoreSkillContribution(
  original: Buffer,
  baseline: Buffer,
  edited: Buffer,
  installedName: string,
): Buffer {
  if (!renameSkill(original, installedName).equals(baseline))
    throw new Error(
      "Skill source changed since sync; resolve upstream changes first",
    );
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    original.toString("utf8"),
  )!;
  const originalName = parseDocument(match[1]!).get("name");
  if (typeof originalName !== "string")
    throw new Error("Source skill name is invalid");
  if (!renameSkill(edited, installedName).equals(edited))
    throw new Error(
      "Rename skills in their source directory rather than a projected output",
    );
  return renameSkill(edited, originalName);
}
