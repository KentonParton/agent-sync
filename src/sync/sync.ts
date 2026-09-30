import { inspectStarter } from "../onboarding/starter.js";
import { repository, type Repository } from "../git/repository.js";
import {
  loadManifest,
  MANIFEST_FILE,
  manifestSchema,
  type Manifest,
} from "../manifest/manifest.js";
import { exists, SourceResolver } from "../sources/source.js";
import { composeInstructions } from "../instructions/instructions.js";
import { composeSkills } from "../skills/skills.js";
import { composePlugins } from "../plugins/plugins.js";
import { McpEnvironment } from "../mcp/mcp.js";
import { OutputPlan } from "./plan.js";
import { reconcile, withLock, type SyncResult } from "./state.js";
import { refreshActivations } from "../plugins/activation.js";
import { join } from "node:path";
export interface SyncOptions {
  cwd?: string;
  offline?: boolean;
  dryRun?: boolean;
  replace?: string[];
  allowMissingManifest?: boolean;
}
export async function sync(options: SyncOptions = {}): Promise<SyncResult> {
  const repo = await repository(options.cwd ?? process.cwd());
  return withLock(repo, async () => {
    if (await inspectStarter(repo))
      throw new Error(
        "The starter instructions have not been edited. Run agent-sync init to import existing configuration, or edit .agent/instructions.md before syncing.",
      );
    const manifest =
      options.allowMissingManifest &&
      !(await exists(join(repo.root, MANIFEST_FILE)))
        ? manifestSchema.parse({})
        : await loadManifest(repo.root);
    const { plan, plugins } = await planEnvironment(
      repo,
      manifest,
      options.offline,
    );
    const result = await reconcile(repo, plan, plugins, {
      ...options,
      outputs: manifest.outputs,
    });
    if (result.applied && !options.dryRun) await refreshActivations(repo);
    return result;
  });
}

export async function planEnvironment(
  repo: Repository,
  manifest: Manifest,
  offline = false,
  sources = new SourceResolver(repo, offline),
) {
  const plan = new OutputPlan();
  const mcp = new McpEnvironment();
  await composeInstructions(manifest, sources, plan);
  await composeSkills(manifest, sources, plan);
  await mcp.load(manifest, sources);
  const plugins = await composePlugins(manifest, sources, plan, mcp, repo.root);
  mcp.render(manifest.targets, plan);
  plan.warnings.push(...sources.warnings);
  return { plan, plugins };
}
