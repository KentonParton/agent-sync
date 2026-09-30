#!/usr/bin/env node
import { runInitCommand } from "./onboarding/command.js";
import { runImportCommand, terminalInteraction } from "./import/command.js";
import { harnessSchema } from "./manifest/manifest.js";
import { parseArgs } from "node:util";
import { sync } from "./sync/sync.js";
import { installHooks, writeHookTemplate } from "./git/hooks.js";
import { diff, merge, promote } from "./contributions/contributions.js";
import { activate } from "./plugins/activation.js";
const help = `agent-sync — synchronize the checked-out branch's agent environment

  import                        Set up shared sources and tool files from existing configs
    --dry-run                   Preview without changing files or prompting
    --yes, -y                   Complete setup without prompting
    --json                      Machine-readable output (preview unless --yes)
    --select KIND:NAME=SOURCE   Resolve a conflicting definition (repeatable)
    --exclude SOURCE           Explicitly omit an unsupported resource (repeatable)
    --user [--home PATH]        Also scan user-level configuration
    --target HARNESS           Limit generated targets (repeatable)
    --outputs committed|local  Keep outputs in Git (default for import/init), or local
  init                          Set up this repo: import existing files or use shared sources
  sync [--offline] [--dry-run]   Update tool files from shared sources
  status                        Show the sync plan without changing outputs
  diff                          Show local edits and their source provenance (JSON)
  keep                          Leave edits in place and report them
  replace PATH...               Back up and replace selected managed outputs
  merge PATH                    Three-way merge with the latest sync candidate
  promote PATH                  Prepare a source contribution branch and patch
    --source-index N            Select an instruction fragment if ambiguous
    --publish                   Commit, push a review branch, and open a draft PR
    --title TEXT --body TEXT    Pull request text (requires GitHub CLI)
  activate codex|cursor         Install native plugins; remember activation for sync
    --home PATH                 Override the host's configuration directory
  install-hooks                 Install post-checkout, preserving existing hooks
  hook-template PATH            Create a Git template for future clones

Common: --cwd PATH, --help. Conflicts exit 2, other errors exit 1.
Native plugins keep host trust/approval requirements; restart after updates.
`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      user: { type: "boolean" },
      expect: { type: "string" },
      outputs: { type: "string" },
      select: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      target: { type: "string", multiple: true },
      offline: { type: "boolean" },
      "dry-run": { type: "boolean" },
      hook: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "source-index": { type: "string" },
      publish: { type: "boolean" },
      branch: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      home: { type: "string" },
    },
  });
  const [command = "help", ...args] = positionals;
  const cwd = values.cwd ?? process.cwd();
  const output = (value: unknown) =>
    console.log(JSON.stringify(value, null, 2));
  const requiredPath = () => {
    if (!args[0]) throw new Error(`${command} requires a path`);
    return args[0];
  };
  if (values.help || command === "help") {
    console.log(help);
    return;
  }
  if (command === "import" || command === "init") {
    if (
      values.outputs &&
      values.outputs !== "local" &&
      values.outputs !== "committed"
    )
      throw new Error("--outputs must be committed or local");
    const select: Record<string, string> = Object.create(null);
    for (const choice of values.select ?? []) {
      const split = choice.indexOf("=");
      if (
        split < 1 ||
        split === choice.length - 1 ||
        Object.hasOwn(select, choice.slice(0, split))
      )
        throw new Error("Use one --select KIND:NAME=SOURCE per conflict");
      select[choice.slice(0, split)] = choice.slice(split + 1);
    }
    const io = terminalInteraction();
    try {
      process.exitCode = await (
        command === "init" ? runInitCommand : runImportCommand
      )(
        {
          cwd,
          yes: values.yes,
          dryRun: values["dry-run"],
          json: values.json,
          user: values.user,
          home: values.home,
          outputs: values.outputs as "local" | "committed" | undefined,
          targets: values.target?.map((t) => harnessSchema.parse(t)),
          select,
          exclude: values.exclude,
          expect: values.expect,
        },
        io,
      );
    } finally {
      io.close();
    }
  } else if (
    command === "sync" ||
    command === "status" ||
    command === "replace"
  ) {
    if (command === "replace") requiredPath();
    const result = await sync({
      cwd,
      offline: values.offline,
      dryRun: command === "status" || values["dry-run"],
      replace: command === "replace" ? args : undefined,
      allowMissingManifest: values.hook,
    });
    if (
      !values.hook ||
      result.changes.some((c) => c.action !== "unchanged") ||
      result.warnings.length
    )
      output(result);
    if (result.changes.some((c) => c.action === "conflict"))
      process.exitCode = 2;
  } else if (command === "diff" || command === "keep") {
    const changes = await diff(cwd);
    output(
      changes.map((c) => ({
        ...c,
        before: Buffer.from(c.before.content, "base64").toString("utf8"),
        after: c.after
          ? Buffer.from(c.after.content, "base64").toString("utf8")
          : null,
      })),
    );
  } else if (command === "merge") output(await merge(requiredPath(), cwd));
  else if (command === "promote") {
    const index =
      values["source-index"] === undefined
        ? undefined
        : Number(values["source-index"]);
    if (index !== undefined && (!Number.isInteger(index) || index < 0))
      throw new Error("--source-index must be a nonnegative integer");
    output(
      await promote(requiredPath(), {
        cwd,
        sourceIndex: index,
        branch: values.branch,
        publish: values.publish,
        title: values.title,
        body: values.body,
      }),
    );
  } else if (command === "install-hooks") output(await installHooks(cwd));
  else if (command === "hook-template")
    output({ path: await writeHookTemplate(requiredPath()) });
  else if (command === "activate") {
    const target = requiredPath();
    if (target !== "codex" && target !== "cursor")
      throw new Error(
        "activate supports codex or cursor; Claude loads native project plugins directly",
      );
    output(await activate(target, { cwd, home: values.home }));
  } else throw new Error(`Unknown command: ${command}. Run agent-sync --help.`);
}
main().catch((error) => {
  console.error(
    `agent-sync: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
