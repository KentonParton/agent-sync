import { OutputOwnership } from "../sync/ownership.js";
import type { Manifest } from "../manifest/manifest.js";
import { join } from "node:path";
import { type Repository } from "../git/repository.js";
import type { OutputPlan } from "../sync/plan.js";
import type { PluginInstallation } from "../plugins/plugins.js";
import {
  equal,
  snapshot,
  saveState,
  reconcile,
  writeSnapshot,
  type Snapshot,
  type SyncState,
} from "../sync/state.js";
import { fileDigest, type ObservedFile } from "./discovery.js";

export interface MigrationOutput {
  path: string;
  action: "create" | "update" | "unchanged" | "blocked";
  reason?: string;
}
export interface Migration {
  outputs: MigrationOutput[];
  baseline: SyncState;
  originals: Map<string, Snapshot | null>;
}
/** Validate the complete migration before creating sources or claiming any existing output. */
export async function planMigration(
  repo: Repository,
  plan: OutputPlan,
  plugins: PluginInstallation[],
  observed: ObservedFile[],
  outputs: Manifest["outputs"],
): Promise<Migration> {
  const ownership = await OutputOwnership.inspect(repo, outputs);
  const migration: Migration = {
    outputs: [],
    originals: new Map(),
    baseline: {
      version: 1,
      head: repo.head,
      files: Object.create(null),
      plugins,
    },
  };
  for (const [path, output] of plan.files) {
    try {
      const current = await snapshot(repo.root, path);
      migration.originals.set(path, current);
      const imported = observed.find(
        (file) => file.root === repo.root && file.path === path,
      );
      const reason =
        ownership.migrationReason(path) ??
        (current && !imported?.adoptable
          ? "This file contains unrelated or excluded settings, or was not imported. Migrate those settings first or exclude this target."
          : current &&
              fileDigest({
                content: Buffer.from(current.content, "base64"),
                executable: current.executable,
              }) !== imported!.digest
            ? "This file changed during preview. Run import again."
            : undefined);
      const next = {
        content: output.content.toString("base64"),
        executable: output.executable,
      };
      migration.outputs.push({
        path,
        action: reason
          ? "blocked"
          : equal(current, next)
            ? "unchanged"
            : current
              ? "update"
              : "create",
        ...(reason && { reason }),
      });
      if (current && !reason)
        migration.baseline.files[path] = {
          ...current,
          kind: output.kind,
          provenance: output.provenance,
        };
    } catch {
      migration.outputs.push({
        path,
        action: "blocked",
        reason:
          "Destination is not a safe regular file. Resolve symlinks or directory collisions before importing.",
      });
    }
  }
  return migration;
}
/** Import confirmation authorizes this transition; it is never a separate user command. */
export async function completeMigration(
  repo: Repository,
  plan: OutputPlan,
  plugins: PluginInstallation[],
  migration: Migration,
  id: string,
  outputs: Manifest["outputs"],
): Promise<string> {
  if (migration.outputs.some((output) => output.action === "blocked"))
    throw new Error("Import has unresolved destination conflicts");
  for (const [path, original] of migration.originals)
    if (!equal(await snapshot(repo.root, path), original))
      throw new Error(`Destination changed after review: ${path}`);
  const backup = `backups/import-${id}.json`;
  await writeSnapshot(repo.stateDir, backup, {
    content: Buffer.from(JSON.stringify(migration.baseline)).toString("base64"),
    executable: false,
  });
  await saveState(repo, migration.baseline);
  const result = await reconcile(repo, plan, plugins, { outputs });
  if (!result.applied)
    throw new Error(
      `A destination changed during migration: ${result.changes
        .filter((change) => change.action === "conflict")
        .map((change) => change.path)
        .join(
          ", ",
        )}. Sources and backups are saved; resolve the conflict and run agent-sync sync.`,
    );
  return join(repo.stateDir, backup);
}
