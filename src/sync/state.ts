import { OutputOwnership } from "./ownership.js";
import type { Manifest } from "../manifest/manifest.js";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Repository } from "../git/repository.js";
import { confinedPath, exists, type Provenance } from "../sources/source.js";
import type { OutputPlan } from "./plan.js";
import type { PluginInstallation } from "../plugins/plugins.js";

const provenanceSchema = z.object({
  source: z.string(),
  path: z.string(),
  ref: z.string().optional(),
  revision: z.string().optional(),
});
const snapshotSchema = z.object({
  content: z.string(),
  executable: z.boolean(),
});
const baselineSchema = snapshotSchema.extend({
  kind: z.enum(["instructions", "skill", "mcp", "plugin"]),
  provenance: z.array(provenanceSchema),
});
const stateSchema = z.object({
  version: z.literal(1),
  head: z.string(),
  files: z.record(z.string(), baselineSchema),
  plugins: z.array(z.custom<PluginInstallation>()).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Baseline = z.infer<typeof baselineSchema>;
export type SyncState = z.infer<typeof stateSchema>;
export type Change = {
  path: string;
  action: "create" | "update" | "remove" | "unchanged" | "conflict";
  reason?: string;
};
export interface SyncResult {
  changes: Change[];
  warnings: string[];
  applied: boolean;
  stateDir: string;
}
export async function readState(repo: Repository): Promise<SyncState> {
  const path = join(repo.stateDir, "active.json");
  if (!(await exists(path)))
    return { version: 1, head: repo.head, files: {}, plugins: [] };
  return stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
export async function snapshot(
  root: string,
  path: string,
): Promise<Snapshot | null> {
  const full = await confinedPath(root, path);
  if (!(await exists(full))) return null;
  const stat = await lstat(full);
  if (!stat.isFile()) throw new Error(`Expected regular output file: ${path}`);
  return {
    content: (await readFile(full)).toString("base64"),
    executable: !!(stat.mode & 0o111),
  };
}
export function equal(
  a: Snapshot | null | undefined,
  b: Snapshot | null | undefined,
): boolean {
  return (
    (!a && !b) ||
    !!(a && b && a.content === b.content && a.executable === b.executable)
  );
}
export async function writeSnapshot(
  root: string,
  path: string,
  value: Snapshot | null,
): Promise<void> {
  const full = await confinedPath(root, path);
  if (!value) {
    await rm(full, { force: true });
    return;
  }
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.agent-sync-${randomUUID()}`;
  try {
    await writeFile(temp, Buffer.from(value.content, "base64"), {
      flag: "wx",
      mode: value.executable ? 0o700 : 0o600,
    });
    await rename(temp, full);
    await chmod(full, value.executable ? 0o700 : 0o600);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function saveState(repo: Repository, state: SyncState) {
  await writeSnapshot(repo.stateDir, "active.json", {
    content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString(
      "base64",
    ),
    executable: false,
  });
}
export async function withLock<T>(
  repo: Repository,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(repo.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(repo.stateDir, "lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Another sync is running, or a previous run stopped. Inspect ${lock} before removing a stale lock.`,
      );
    throw error;
  }
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    if (await exists(join(repo.stateDir, "journal.json")))
      throw new Error(
        `An interrupted transaction needs recovery. See ${join(repo.stateDir, "journal.json")}; outputs were preserved.`,
      );
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function reconcile(
  repo: Repository,
  plan: OutputPlan,
  plugins: PluginInstallation[],
  options: {
    dryRun?: boolean;
    replace?: string[];
    untrackedDestination?: boolean;
    outputs?: Manifest["outputs"];
  },
): Promise<SyncResult> {
  await mkdir(repo.root, { recursive: true });
  await mkdir(repo.stateDir, { recursive: true, mode: 0o700 });
  const old = await readState(repo);
  for (const path of options.replace ?? [])
    if (!old.files[path])
      throw new Error(
        `Cannot replace an output not owned by agent-sync: ${path}`,
      );
  const desired: SyncState = {
    version: 1,
    head: repo.head,
    files: Object.create(null),
    plugins,
  };
  for (const [path, file] of plan.files)
    desired.files[path] = { ...file, content: file.content.toString("base64") };
  const ownership = await OutputOwnership.inspect(
    repo,
    options.outputs,
    options.untrackedDestination,
  );
  const changes: Change[] = [];
  const current = new Map<string, Snapshot | null>();
  for (const path of [
    ...new Set([...Object.keys(old.files), ...Object.keys(desired.files)]),
  ].sort()) {
    const next = desired.files[path];
    const baseline = old.files[path];
    let actual: Snapshot | null;
    try {
      actual = await snapshot(repo.root, path);
    } catch (error) {
      changes.push({
        path,
        action: "conflict",
        reason: (error as Error).message,
      });
      continue;
    }
    current.set(path, actual);
    const replacing = options.replace?.includes(path) && baseline;
    if (ownership.retain(path, next)) {
      changes.push({
        path,
        action: "unchanged",
        reason: "Committed file retained; Git controls its removal",
      });
      continue;
    }
    const reason = ownership.conflict(
      path,
      actual,
      baseline,
      next,
      !!replacing,
    );
    if (reason) changes.push({ path, action: "conflict", reason });
    else
      changes.push({
        path,
        action: equal(actual, next)
          ? "unchanged"
          : !next
            ? "remove"
            : actual
              ? "update"
              : "create",
      });
  }
  const result: SyncResult = {
    changes,
    warnings: plan.warnings,
    applied: false,
    stateDir: repo.stateDir,
  };
  if (options.dryRun) return result;
  if (changes.some((c) => c.action === "conflict")) {
    await writeSnapshot(repo.stateDir, "candidate.json", {
      content: Buffer.from(JSON.stringify(desired, null, 2)).toString("base64"),
      executable: false,
    });
    return result;
  }
  const pending = changes.filter((c) => c.action !== "unchanged");
  if (!pending.length) {
    await saveState(repo, desired);
    await rm(join(repo.stateDir, "candidate.json"), { force: true });
    return { ...result, applied: true };
  }
  const before = Object.fromEntries(
    pending.map((c) => [c.path, current.get(c.path)!]),
  );
  const transaction = { created: new Date().toISOString(), before, state: old };
  await writeFile(
    join(repo.stateDir, "journal.json"),
    JSON.stringify(transaction),
    { mode: 0o600, flag: "wx" },
  );
  if (options.replace?.length) {
    const backup = join(repo.stateDir, "backups", randomUUID());
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(join(backup, "before.json"), JSON.stringify(transaction), {
      mode: 0o600,
    });
  }
  const written: string[] = [];
  try {
    // Recheck all paths before applying the first change, then once more at each write.
    for (const change of pending)
      if (
        !equal(await snapshot(repo.root, change.path), current.get(change.path))
      )
        throw new Error(`Output changed during sync: ${change.path}`);
    for (const change of pending) {
      if (
        !equal(await snapshot(repo.root, change.path), current.get(change.path))
      )
        throw new Error(`Output changed during sync: ${change.path}`);
      await writeSnapshot(
        repo.root,
        change.path,
        desired.files[change.path] ?? null,
      );
      written.push(change.path);
    }
    await saveState(repo, desired);
  } catch (error) {
    // Never roll back over a concurrent editor's change.
    for (const path of written.reverse()) {
      if (!equal(await snapshot(repo.root, path), desired.files[path]))
        throw new Error(
          `Concurrent edit prevented rollback; recover using ${repo.stateDir}/journal.json`,
          { cause: error },
        );
      await writeSnapshot(repo.root, path, current.get(path)!);
    }
    await saveState(repo, old);
    await rm(join(repo.stateDir, "journal.json"));
    throw error;
  }
  await rm(join(repo.stateDir, "journal.json"));
  await rm(join(repo.stateDir, "candidate.json"), { force: true });
  return { ...result, applied: true };
}
export async function localChanges(repo: Repository): Promise<
  {
    path: string;
    before: Snapshot;
    after: Snapshot | null;
    provenance: Provenance[];
  }[]
> {
  const state = await readState(repo);
  const changes = [];
  for (const [path, before] of Object.entries(state.files)) {
    const after = await snapshot(repo.root, path);
    if (!equal(before, after))
      changes.push({ path, before, after, provenance: before.provenance });
  }
  return changes;
}
