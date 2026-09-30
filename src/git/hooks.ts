import { inspectStarter } from "../onboarding/starter.js";
import { loadManifest } from "../manifest/manifest.js";
import { planEnvironment } from "../sync/sync.js";
import { reconcile, writeSnapshot } from "../sync/state.js";
import { readFile, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, repository } from "./repository.js";
import { exists } from "../sources/source.js";
import { readState, withLock } from "../sync/state.js";
const exec = promisify(execFile);
const marker = "# agent-sync managed checkout hook v1";
function quote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
export function checkoutHook(cliPath: string, previousHook?: string): string {
  return `#!/bin/sh\n${marker}\nstatus=0\n${previousHook ? `if [ -x ${quote(previousHook)} ]; then\n  ${quote(previousHook)} "$@" || status=$?\nfi\n` : ""}# A file checkout does not change the branch environment.\nif [ "\${3:-1}" = "1" ]; then\n  ${quote(process.execPath)} ${quote(cliPath)} sync --hook || printf '%s\\n' 'agent-sync: sync needs attention; existing resources were preserved.' >&2\nfi\nexit "$status"\n`;
}
export async function installHooks(
  cwd = process.cwd(),
  cliPath = fileURLToPath(new URL("../cli.js", import.meta.url)),
) {
  const repo = await repository(cwd);
  return withLock(repo, async () => {
    const state = await readState(repo);
    if ((await inspectStarter(repo)) || !Object.keys(state.files).length)
      throw new Error(
        "Finish setup with agent-sync init or agent-sync sync before installing checkout automation.",
      );
    const manifest = await loadManifest(repo.root);
    const { plan, plugins } = await planEnvironment(repo, manifest, true);
    const preview = await reconcile(repo, plan, plugins, {
      dryRun: true,
      outputs: manifest.outputs,
    });
    if (preview.changes.some((c) => c.action !== "unchanged"))
      throw new Error(
        "Tool files are not in sync. Run agent-sync sync and resolve conflicts before installing checkout automation.",
      );
    let previous: string | undefined;
    try {
      previous = await git(repo.root, ["config", "--get", "core.hooksPath"]);
    } catch {
      /* Git default. */
    }
    const hooks = join(repo.stateDir, "hooks");
    const metadataPath = join(repo.stateDir, "hook-install.json");
    let saved:
      | {
          hooks: string;
          content: string;
          previous?: string;
          files?: Record<string, string>;
        }
      | undefined;
    if (await exists(metadataPath)) {
      saved = JSON.parse(await readFile(metadataPath, "utf8"));
      if (saved?.hooks !== hooks)
        throw new Error(
          "Hook metadata belongs to another location; preserve it and inspect the installation.",
        );
      for (const [name, expected] of Object.entries(
        saved.files ?? { "post-checkout": saved.content },
      )) {
        if ((await readFile(join(hooks, name), "utf8")) !== expected)
          throw new Error(
            "An Agent Sync hook was edited locally; preserve the changes before reinstalling.",
          );
      }
      if (previous === hooks) previous = saved.previous;
    }
    const previousDir = previous
      ? isAbsolute(previous)
        ? previous
        : resolve(repo.root, previous)
      : resolve(
          repo.root,
          await git(repo.root, ["rev-parse", "--git-common-dir"]),
          "hooks",
        );
    const oldHook = join(previousDir, "post-checkout");
    const content = checkoutHook(
      cliPath,
      (await exists(oldHook)) ? oldHook : undefined,
    );
    const files: Record<string, string> = { "post-checkout": content };
    // Forward the configured hook manager without editing its scripts.
    if (await exists(previousDir))
      for (const name of await readdir(previousDir)) {
        if (
          name === "post-checkout" ||
          name.endsWith(".sample") ||
          !/^[a-z-]+$/.test(name)
        )
          continue;
        const old = join(previousDir, name);
        files[name] =
          `#!/bin/sh\n${marker}\nif [ -x ${quote(old)} ]; then exec ${quote(old)} "$@"; fi\n`;
      }
    const owned =
      saved?.files ?? (saved ? { "post-checkout": saved.content } : {});
    for (const name of Object.keys(files)) {
      if (!Object.hasOwn(owned, name) && (await exists(join(hooks, name))))
        throw new Error(
          `Existing hook is not owned by this installation: ${name}`,
        );
    }
    const configured = await git(repo.root, [
      "config",
      "--get",
      "core.hooksPath",
    ]).catch(() => undefined);
    if (configured === hooks && JSON.stringify(files) === JSON.stringify(owned))
      return { hooks, installed: false };
    await mkdir(hooks, { recursive: true });
    for (const [name, text] of Object.entries(files))
      await writeSnapshot(hooks, name, {
        content: Buffer.from(text).toString("base64"),
        executable: true,
      });
    for (const name of Object.keys(owned))
      if (!Object.hasOwn(files, name)) await rm(join(hooks, name));
    await exec("git", ["config", "--local", "core.hooksPath", hooks], {
      cwd: repo.root,
    });
    await writeFile(
      metadataPath,
      JSON.stringify({ hooks, previous, content, files }),
      { mode: 0o600 },
    );
    return { hooks, installed: true };
  });
}
export async function writeHookTemplate(
  directory: string,
  cliPath = fileURLToPath(new URL("../cli.js", import.meta.url)),
) {
  const path = join(resolve(directory), "hooks", "post-checkout");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, checkoutHook(cliPath), { flag: "wx", mode: 0o755 });
  return path;
}
