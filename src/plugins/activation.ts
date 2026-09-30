import { pluginMarketplaceName } from "./plugins.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import TOML from "@iarna/toml";
import { repository, type Repository } from "../git/repository.js";
import { exists, SourceResolver } from "../sources/source.js";
import {
  equal,
  readState,
  reconcile,
  withLock,
  type Snapshot,
} from "../sync/state.js";
import { OutputPlan } from "../sync/plan.js";
const exec = promisify(execFile);
export type NativeTarget = "codex" | "cursor";
interface ActivationRecord {
  target: NativeTarget;
  home: string;
  installed: Record<string, { path: string; files: Record<string, Snapshot> }>;
}
export async function activate(
  target: NativeTarget,
  options: { cwd?: string; home?: string } = {},
) {
  const repo = await repository(options.cwd ?? process.cwd());
  return withLock(repo, () => refreshActivation(repo, target, options.home));
}
export async function refreshActivations(repo: Repository): Promise<void> {
  for (const target of ["codex", "cursor"] as const)
    if (await exists(join(repo.stateDir, `activation-${target}.json`)))
      await refreshActivation(repo, target);
}
async function refreshActivation(
  repo: Repository,
  target: NativeTarget,
  requestedHome?: string,
) {
  const recordPath = join(repo.stateDir, `activation-${target}.json`);
  const prior: ActivationRecord | undefined = (await exists(recordPath))
    ? JSON.parse(await readFile(recordPath, "utf8"))
    : undefined;
  const home = resolve(
    requestedHome ??
      prior?.home ??
      (target === "codex"
        ? (process.env.CODEX_HOME ?? join(homedir(), ".codex"))
        : join(homedir(), ".cursor")),
  );
  if (prior && prior.home !== home)
    throw new Error("This repository is already activated in a different home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const state = await readState(repo);
  const plugins = state.plugins.filter(
    (p) => p.mode === "native" && p.targets.includes(target),
  );
  const source = await new SourceResolver(repo, true).resolve({});
  const identity = pluginMarketplaceName(repo.root);
  const record: ActivationRecord = { target, home, installed: {} };
  if (target === "cursor") {
    const plan = new OutputPlan();
    for (const plugin of plugins)
      plan.tree(
        `plugins/local/${identity}-${plugin.name}`,
        await source.tree(plugin.path),
        "plugin",
        { source: "local", path: plugin.path },
      );
    // User-level outputs have their own ownership ledger, but no Git index.
    const destination: Repository = {
      root: home,
      stateDir: join(repo.stateDir, "cursor-native"),
      head: state.head,
    };
    await mkdir(home, { recursive: true });
    // reconcile checks Git tracking; a small managed repository is never created in the user's home.
    const result = await reconcile(destination, plan, [], {
      untrackedDestination: true,
    });
    if (!result.applied)
      throw new Error(
        `Cursor native plugin changes preserved: ${result.changes
          .filter((c) => c.action === "conflict")
          .map((c) => c.path)
          .join(", ")}`,
      );
  } else {
    // Native CLI commands own the host's registration schema. Guard every cache copy before reinstalling.
    for (const [name, installed] of Object.entries(prior?.installed ?? {})) {
      const actual = await sourceTree(home, installed.path);
      if (
        Object.keys(actual).length !== Object.keys(installed.files).length ||
        Object.entries(installed.files).some(
          ([path, baseline]) => !equal(actual[path], baseline),
        )
      )
        throw new Error(
          `Local edits in installed Codex plugin ${name}; preserve or promote them before syncing`,
        );
    }
    const marketRoot = join(repo.stateDir, "codex-marketplace");
    const marketDir = join(marketRoot, ".agents/plugins");
    const plan = new OutputPlan();
    for (const plugin of plugins)
      plan.tree(
        `plugins/${plugin.name}`,
        await source.tree(plugin.path),
        "plugin",
        { source: "local", path: plugin.path },
      );
    const result = await reconcile(
      {
        root: marketRoot,
        stateDir: join(repo.stateDir, "codex-native"),
        head: state.head,
      },
      plan,
      [],
      { untrackedDestination: true },
    );
    if (!result.applied)
      throw new Error(
        "Local edits in the Codex activation source; resolve before activating",
      );
    await mkdir(marketDir, { recursive: true });
    await writeFile(
      join(marketDir, "marketplace.json"),
      JSON.stringify({
        name: identity,
        plugins: plugins.map((p) => ({
          name: p.name,
          source: { source: "local", path: `./plugins/${p.name}` },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Productivity",
        })),
      }),
      { mode: 0o600 },
    );
    const cli = async (args: string[]) =>
      (
        await exec("codex", ["plugin", ...args], {
          cwd: repo.root,
          env: { ...process.env, CODEX_HOME: home },
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    if (!prior) {
      const config = (await exists(join(home, "config.toml")))
        ? TOML.parse(await readFile(join(home, "config.toml"), "utf8"))
        : {};
      if (config.marketplaces && identity in (config.marketplaces as object))
        throw new Error(
          `Codex marketplace ${identity} already exists and is not owned by this repository`,
        );
      if (await exists(join(home, "plugins/cache", identity)))
        throw new Error(
          `Codex plugin cache ${identity} already exists and is not owned by this repository`,
        );
    }
    // Persist ownership before host commands so a partial install is visible on retry.
    record.installed = prior?.installed ?? {};
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    await cli(["marketplace", "add", marketRoot, "--json"]);
    for (const plugin of plugins) {
      const info = JSON.parse(
        await cli(["add", `${plugin.name}@${identity}`, "--json"]),
      ) as { installedPath: string };
      const path = relative(home, info.installedPath).split("\\").join("/");
      const files = await sourceTree(home, path);
      record.installed[plugin.name] = { path, files };
      await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    }
    for (const name of Object.keys(record.installed))
      if (!plugins.some((p) => p.name === name)) {
        await cli(["remove", `${name}@${identity}`]);
        delete record.installed[name];
      }
  }
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  return { target, home, plugins: plugins.map((p) => p.name) };
}
async function sourceTree(
  root: string,
  path: string,
): Promise<Record<string, Snapshot>> {
  const source = await new SourceResolver(
    { root, stateDir: "", head: "" },
    true,
  ).resolve({});
  if (!(await exists(join(root, path)))) return {};
  return Object.fromEntries(
    [...(await source.tree(path))].map(([path, file]) => [
      path,
      { content: file.content.toString("base64"), executable: file.executable },
    ]),
  );
}
