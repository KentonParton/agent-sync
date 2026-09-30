import {
  inspectStarter,
  archiveStarter,
  restoreStarter,
} from "../onboarding/starter.js";
import {
  planMigration,
  completeMigration,
  type Migration,
  type MigrationOutput,
} from "./migration.js";
import type { OutputPlan } from "../sync/plan.js";
import type { PluginInstallation } from "../plugins/plugins.js";
import {
  writeSnapshot,
  readState,
  snapshot,
  equal,
  withLock,
} from "../sync/state.js";
import { mkdir, open, rm, rmdir, writeFile, readdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { homedir } from "node:os";
import { stringify } from "yaml";
import {
  MANIFEST_FILE,
  manifestSchema,
  type Harness,
  type Manifest,
} from "../manifest/manifest.js";
import { repository, type Repository } from "../git/repository.js";
import {
  confinedPath,
  exists,
  fingerprint,
  SourceResolver,
  type SourceFile,
  type FileTree,
  type ResolvedSource,
} from "../sources/source.js";
import { planEnvironment } from "../sync/sync.js";
import {
  discover,
  fileDigest,
  type Discovery,
  type ImportIssue,
  type ImportResource,
  type ObservedFile,
} from "./discovery.js";

export interface ImportOptions {
  cwd?: string;
  apply?: boolean;
  user?: boolean;
  home?: string;
  targets?: Harness[];
  outputs?: Manifest["outputs"];
  select?: Record<string, string>;
  exclude?: string[];
  expect?: string;
}
export interface ImportPlan {
  id: string;
  applied: boolean;
  manifest: Manifest;
  resources: {
    kind: ImportResource["kind"];
    name: string;
    destination: string;
    sources: string[];
  }[];
  duplicates: {
    kind: ImportResource["kind"];
    name: string;
    sources: string[];
  }[];
  suggestions: {
    kind: ImportResource["kind"];
    names: string[];
    sources: string[];
  }[];
  conflicts: { key: string; sources: string[] }[];
  issues: ImportIssue[];
  warnings: string[];
  excluded: string[];
  files: string[];
  outputs: MigrationOutput[];
  backup?: string;
  retained: string[];
  recoveringStarter: boolean;
}
export const IMPORT_RECEIPT = "import-receipt.json";
export interface ImportReceipt {
  version: 1;
  id: string;
  originals: ObservedFile[];
  created: Record<string, string>;
  completed?: boolean;
}
interface PreparedImport {
  report: ImportPlan;
  files: FileTree;
  observed: ObservedFile[];
  environment?: { plan: OutputPlan; plugins: PluginInstallation[] };
  migration?: Migration;
  starter?: FileTree;
  reuseSourceDirectory: boolean;
}
class ImportSources extends SourceResolver {
  constructor(
    repo: Repository,
    private files: FileTree,
  ) {
    super(repo, true);
  }
  override async resolve(): Promise<ResolvedSource> {
    const file = async (path: string) => {
      const value = this.files.get(posix.normalize(path));
      if (!value) throw new Error(`Missing import source ${path}`);
      return value;
    };
    return {
      provenance: (path) => ({ source: "local", path }),
      file,
      tree: async (path) =>
        new Map(
          [...this.files]
            .filter(([name]) => name.startsWith(`${posix.normalize(path)}/`))
            .map(([name, value]) => [
              name.slice(posix.normalize(path).length + 1),
              value,
            ]),
        ),
    };
  }
}
export async function importResources(
  options: ImportOptions = {},
): Promise<ImportPlan> {
  if (options.home && !options.user)
    throw new Error("--home requires --user when importing");
  const repo = await repository(options.cwd ?? process.cwd());
  const run = async () => {
    const prepared = await prepare(repo, options);
    if (options.expect && options.expect !== prepared.report.id)
      throw new Error(
        "Import plan changed since review; preview again before applying",
      );
    if (
      !options.apply ||
      prepared.report.conflicts.length ||
      prepared.report.issues.length
    )
      return prepared.report;
    const backup = await applyImport(repo, prepared);
    return { ...prepared.report, applied: true, backup };
  };
  return options.apply ? withLock(repo, run) : run();
}
async function prepare(
  repo: Repository,
  options: ImportOptions,
): Promise<PreparedImport> {
  const starter = await inspectStarter(repo);
  const exclude = new Set(options.exclude ?? []);
  const found: Discovery[] = [await discover(repo.root, "project", exclude)];
  if (options.user)
    found.push(
      await discover(resolve(options.home ?? homedir()), "user", exclude),
    );
  const resources = found.flatMap((f) => f.resources);
  const manifest = manifestSchema.parse({
    targets: options.targets,
    outputs: options.outputs ?? "committed",
  });
  const report: ImportPlan = {
    id: "",
    applied: false,
    manifest,
    resources: [],
    duplicates: [],
    suggestions: [],
    conflicts: [],
    issues: found.flatMap((f) => f.issues),
    warnings: found.flatMap((f) => f.warnings),
    excluded: found.flatMap((f) => f.excluded),
    files: [],
    outputs: [],
    retained: found.flatMap((f) => f.retained),
    recoveringStarter: !!starter,
  };
  for (const excluded of exclude)
    if (!report.excluded.includes(excluded))
      report.issues.push({
        source: excluded,
        message:
          "Exclusion did not match a discovered location. Check the source ID.",
      });
  const groups = new Map<string, ImportResource[]>();
  for (const resource of resources) {
    const key =
      resource.kind === "instructions"
        ? `instructions:${resource.digest}`
        : `${resource.kind}:${resource.name}`;
    const group = groups.get(key) ?? [];
    group.push(resource);
    groups.set(key, group);
  }
  const selected: {
    resource: ImportResource;
    equivalents: ImportResource[];
  }[] = [];
  for (const [key, group] of groups) {
    const chosen = options.select?.[key];
    let resource: ImportResource | undefined;
    if (chosen) resource = group.find((r) => r.id === chosen);
    if (chosen && !resource) {
      report.issues.push({
        source: chosen,
        message: `Selection is not an option for ${key}`,
      });
      continue;
    }
    if (!chosen && new Set(group.map((r) => r.digest)).size > 1) {
      report.conflicts.push({ key, sources: group.map((r) => r.id) });
      continue;
    }
    resource ??= group[0]!;
    const equivalents = group.filter((r) => r.digest === resource.digest);
    if (equivalents.length > 1)
      report.duplicates.push({
        kind: resource.kind,
        name: resource.name,
        sources: equivalents.map((r) => r.id),
      });
    selected.push({ resource, equivalents });
  }
  for (const key of Object.keys(options.select ?? {}))
    if (!groups.has(key))
      report.issues.push({
        source: key,
        message: "Selection key did not match a discovered resource",
      });
  const equivalentNames = new Map<string, ImportResource[]>();
  for (const { resource } of selected) {
    if (resource.kind === "instructions") continue;
    const key = `${resource.kind}:${resource.digest}`;
    const group = equivalentNames.get(key) ?? [];
    group.push(resource);
    equivalentNames.set(key, group);
  }
  for (const group of equivalentNames.values())
    if (group.length > 1)
      report.suggestions.push({
        kind: group[0]!.kind,
        names: group.map((r) => r.name),
        sources: group.map((r) => r.id),
      });
  const files: FileTree = new Map();
  const add = (path: string, file: SourceFile) => {
    if (files.has(path))
      throw new Error(`Import destination collision: ${path}`);
    files.set(path, file);
  };
  const servers: Record<string, unknown> = Object.create(null);
  let instruction = 0;
  for (const { resource, equivalents } of selected) {
    let destination: string;
    switch (resource.kind) {
      case "instructions":
        destination = `.agent/instructions/${String(++instruction).padStart(2, "0")}-${resource.name}.md`;
        add(destination, resource.files.get("")!);
        manifest.instructions.push({
          path: destination,
          ...(equivalents.every((r) => r.targets) && {
            targets: [...new Set(equivalents.flatMap((r) => r.targets ?? []))],
          }),
        });
        break;
      case "mcp":
        destination = ".agent/mcp.json";
        servers[resource.name] = resource.server;
        break;
      case "skill":
        destination = `.agent/skills/${resource.name}`;
        for (const [path, file] of resource.files)
          add(`${destination}/${path}`, file);
        break;
      case "plugin":
        destination = `.agent/plugins/${resource.name}`;
        for (const [path, file] of resource.files)
          add(`${destination}/${path}`, file);
        const targets = resource.targets!.filter((t) =>
          manifest.targets.includes(t),
        );
        if (!targets.length)
          report.issues.push({
            source: resource.id,
            message: "Plugin is incompatible with every selected target",
          });
        else
          manifest.plugins.push({ path: destination, mode: "native", targets });
        break;
    }
    report.resources.push({
      kind: resource.kind,
      name: resource.name,
      destination,
      sources: equivalents.map((r) => r.id),
    });
  }
  if (selected.some((s) => s.resource.kind === "skill"))
    manifest.skills.push({ path: ".agent/skills" });
  if (Object.keys(servers).length) {
    add(".agent/mcp.json", {
      content: Buffer.from(
        JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
      ),
      executable: false,
    });
    manifest.mcp.push({ path: ".agent/mcp.json" });
  }
  if (!selected.length && !report.issues.length && !report.conflicts.length)
    report.issues.push({
      source: "import",
      message: "No resources were found in the supported locations",
    });
  add(MANIFEST_FILE, {
    content: Buffer.from(stringify(manifest)),
    executable: false,
  });
  report.files = [...files.keys()].sort();
  // An empty directory has no source material to protect; nonempty trees remain off limits.
  let reuseSourceDirectory = false;
  for (const path of [MANIFEST_FILE, ".agent"]) {
    try {
      const full = await confinedPath(repo.root, path);
      if (!starter && (await exists(full))) {
        if (path === ".agent" && (await readdir(full)).length === 0) {
          reuseSourceDirectory = true;
          continue;
        }
        report.issues.push({
          source: path,
          message:
            "Import requires a new manifest and an absent or empty .agent directory; existing source material is left untouched",
        });
      }
    } catch {
      report.issues.push({
        source: path,
        message: "Import destination cannot safely be written",
      });
    }
  }
  const state = await readState(repo);
  if (
    (await exists(join(repo.stateDir, IMPORT_RECEIPT))) ||
    Object.keys(state.files).length > 0 ||
    state.plugins.length > 0
  )
    report.issues.push({
      source: "import",
      message:
        "This repository already has import or sync state; import is an onboarding operation",
    });
  const observed = [
    ...new Map(
      found.flatMap((f) => f.observed).map((f) => [`${f.root}\0${f.path}`, f]),
    ).values(),
  ];
  let environment: PreparedImport["environment"];
  let migration: Migration | undefined;
  if (!report.issues.length && !report.conflicts.length) {
    try {
      environment = await planEnvironment(
        repo,
        manifest,
        true,
        new ImportSources(repo, files),
      );
      const { plan, plugins } = environment;
      migration = await planMigration(
        repo,
        plan,
        plugins,
        observed,
        manifest.outputs,
      );
      report.outputs = migration.outputs;
      for (const output of report.outputs)
        if (output.action === "blocked")
          report.issues.push({ source: output.path, message: output.reason! });
      report.warnings.push(...plan.warnings);
      const retainedImports = observed
        .filter((file) => file.root === repo.root && !plan.files.has(file.path))
        .map((file) => file.path);
      report.retained = [
        ...new Set([...report.retained, ...retainedImports]),
      ].sort();
      if (retainedImports.length)
        report.warnings.push(
          "Some original files are outside the generated destinations and will remain unmanaged after import. Review them to avoid duplicate host discovery.",
        );
    } catch {
      report.issues.push({
        source: "import",
        message:
          "The selected resources cannot generate a valid environment for these targets. Check incompatible MCP settings, skill names, and plugin manifests.",
      });
    }
  }
  if (starter)
    report.warnings.push(
      "An untouched starter from init will be backed up and replaced by the imported sources.",
    );
  report.id = fingerprint(
    JSON.stringify({
      root: repo.root,
      manifest,
      files: [...files].map(([p, f]) => [p, fileDigest(f)]),
      observed,
      selected: report.resources,
      exclude: report.excluded,
      conflicts: report.conflicts,
      issues: report.issues,
      outputs: report.outputs,
      reuseSourceDirectory,
      starter: starter
        ? [...starter].map(([path, file]) => [path, fileDigest(file)])
        : undefined,
    }),
  );
  return {
    report,
    files,
    observed,
    environment,
    migration,
    starter,
    reuseSourceDirectory,
  };
}
async function applyImport(repo: Repository, prepared: PreparedImport) {
  const previousState = await snapshot(repo.stateDir, "active.json");
  for (const file of prepared.observed) {
    const source = await new SourceResolver(
      { ...repo, root: file.root },
      true,
    ).resolve({});
    if (fileDigest(await source.file(file.path)) !== file.digest)
      throw new Error("An input changed during import; preview again");
  }
  const created: Record<string, string> = Object.create(null);
  const receipt: ImportReceipt = {
    version: 1,
    id: prepared.report.id,
    originals: prepared.observed,
    created,
  };
  if (prepared.starter)
    await archiveStarter(repo, prepared.starter, prepared.report.id);
  const sourceRoot = await confinedPath(repo.root, ".agent");
  if (prepared.reuseSourceDirectory) {
    if ((await readdir(sourceRoot)).length)
      throw new Error("Source directory changed during import; preview again");
  } else {
    await mkdir(sourceRoot);
  }
  let receiptCreated = false;
  try {
    for (const [path, file] of prepared.files) {
      const full = await confinedPath(repo.root, path);
      await mkdir(dirname(full), { recursive: true });
      const handle = await open(full, "wx", file.executable ? 0o700 : 0o600);
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
      created[path] = fileDigest(file);
    }
    await writeFile(
      join(repo.stateDir, IMPORT_RECEIPT),
      JSON.stringify(receipt, null, 2),
      { flag: "wx", mode: 0o600 },
    );

    receiptCreated = true;
    const backup = await completeMigration(
      repo,
      prepared.environment!.plan,
      prepared.environment!.plugins,
      prepared.migration!,
      receipt.id,
      prepared.report.manifest.outputs,
    );
    await writeSnapshot(repo.stateDir, IMPORT_RECEIPT, {
      content: Buffer.from(
        JSON.stringify({ ...receipt, completed: true }, null, 2),
      ).toString("base64"),
      executable: false,
    });
    return backup;
  } catch (error) {
    // A pre-onboarding hook can leave an empty ledger. Only a new baseline
    // or an unfinished transaction makes this attempt resumable through sync.
    if (
      !equal(await snapshot(repo.stateDir, "active.json"), previousState) ||
      (await exists(join(repo.stateDir, "journal.json")))
    )
      throw new Error(
        `Import saved sources and backups but could not finish. Resolve the reported problem, then run agent-sync sync. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    if (receiptCreated) await rm(join(repo.stateDir, IMPORT_RECEIPT));
    // Remove only exact files created by this attempt, never a concurrently edited file.
    const source = await new SourceResolver(repo, true).resolve({});
    for (const [path, digest] of Object.entries(created).reverse())
      if (
        (await exists(await confinedPath(repo.root, path))) &&
        fileDigest(await source.file(path)) === digest
      )
        await rm(join(repo.root, path));
    // Rollback removes only directories created by this import, retaining a reused root.
    const directories = new Set<string>(
      prepared.reuseSourceDirectory ? [] : [".agent"],
    );
    for (const path of prepared.files.keys()) {
      let directory = posix.dirname(path);
      while (directory.startsWith(".agent/")) {
        directories.add(directory);
        directory = posix.dirname(directory);
      }
    }
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    )) {
      try {
        await rmdir(await confinedPath(repo.root, directory));
      } catch (cleanupError) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (cleanupError as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw cleanupError;
      }
    }
    if (prepared.starter) await restoreStarter(repo, prepared.starter);
    throw error;
  }
}
