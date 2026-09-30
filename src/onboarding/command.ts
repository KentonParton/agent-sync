import { join } from "node:path";
import { repository } from "../git/repository.js";
import { installHooks } from "../git/hooks.js";
import { MANIFEST_FILE } from "../manifest/manifest.js";
import { confinedPath, exists } from "../sources/source.js";
import { withLock } from "../sync/state.js";
import { sync } from "../sync/sync.js";
import { discover } from "../import/discovery.js";
import {
  runImportCommand,
  type ImportCommandOptions,
  type ImportInteraction,
} from "../import/command.js";
import { createStarter, inspectStarter } from "./starter.js";

/** One entry point for a new project, an existing environment, or a teammate's fresh clone. */
export async function runInitCommand(
  options: ImportCommandOptions,
  io: ImportInteraction,
): Promise<number> {
  if (options.yes && options.dryRun)
    throw new Error("Choose --yes or --dry-run");
  const repo = await repository(options.cwd ?? process.cwd());
  const starter = await inspectStarter(repo);
  const configured =
    !starter && (await exists(await confinedPath(repo.root, MANIFEST_FILE)));
  if (configured) {
    if (!io.interactive && !options.yes && !options.dryRun && !options.json) {
      io.write(
        "This repository already has Agent Sync sources. Run agent-sync sync to set up this checkout, or init --yes to sync without prompting.",
      );
      return 0;
    }
    const preview = await sync({ cwd: repo.root, dryRun: true });
    if (
      options.dryRun ||
      options.json ||
      preview.changes.some((c) => c.action === "conflict")
    ) {
      if (
        options.json &&
        (!options.yes || preview.changes.some((c) => c.action === "conflict"))
      )
        io.write(JSON.stringify(preview, null, 2));
      else if (!options.json)
        io.write(
          preview.changes
            .map(
              (c) =>
                `${c.action}: ${c.path}${c.reason ? ` — ${c.reason}` : ""}`,
            )
            .join("\n") || "No tool files need updating.",
        );
      if (preview.changes.some((c) => c.action === "conflict")) return 2;
      if (!options.yes || options.dryRun) return 0;
    } else if (!options.yes) {
      io.write(
        "This repository already has shared sources. Set up this checkout by syncing its tool files.",
      );
      const answer = await io.ask("Sync this checkout? [y/N]: ");
      if (!answer || !["y", "yes"].includes(answer.trim().toLowerCase())) {
        io.write("Setup cancelled.");
        return 0;
      }
    }
    const result = await sync({ cwd: repo.root });
    if (options.json) io.write(JSON.stringify(result, null, 2));
    else
      io.write(
        result.applied
          ? "This checkout is ready."
          : "Setup needs attention. Run agent-sync status for conflicts.",
      );
    if (!result.applied) return 2;
  } else {
    const found = await discover(
      repo.root,
      "project",
      new Set(options.exclude),
    );
    if (found.resources.length || found.issues.length || options.user) {
      if (!options.json)
        io.write(
          starter
            ? "Found existing tool configuration and an untouched starter. Import will recover the partial setup."
            : "Found existing tool configuration. Starting guided import.",
        );
      const status = await runImportCommand({ ...options, cwd: repo.root }, io);
      if (status || !(await exists(join(repo.stateDir, "active.json"))))
        return status;
    } else {
      const previewOnly = options.dryRun || (options.json && !options.yes);
      if (!starter && !previewOnly)
        await withLock(repo, () => createStarter(repo, options.outputs));
      if (options.json)
        io.write(
          JSON.stringify({
            action: starter ? "edit-starter" : "create-starter",
            applied: !starter && !previewOnly,
            manifest: MANIFEST_FILE,
          }),
        );
      if (!options.json)
        io.write(
          previewOnly
            ? "Would create .agent-sync.yaml and .agent/instructions.md."
            : "Starter ready. Edit .agent/instructions.md, then run agent-sync sync. After a successful sync, run agent-sync install-hooks.",
        );
      return 0;
    }
  }
  if (io.interactive && !options.yes && !options.json && !options.dryRun) {
    const answer = await io.ask(
      "Sync automatically after branch checkout? [y/N]: ",
    );
    if (answer && ["y", "yes"].includes(answer.trim().toLowerCase())) {
      await installHooks(repo.root);
      io.write("Checkout hook ready. Existing hooks are preserved.");
    }
  }
  return 0;
}
