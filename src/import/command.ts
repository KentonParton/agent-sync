import { createInterface } from "node:readline";
import {
  importResources,
  type ImportOptions,
  type ImportPlan,
} from "./import.js";

export interface ImportInteraction {
  interactive: boolean;
  write(message: string): void;
  ask(question: string): Promise<string | undefined>;
}
export function terminalInteraction(): ImportInteraction & { close(): void } {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let readline: ReturnType<typeof createInterface> | undefined;
  let pending: ((answer: string | undefined) => void) | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    pending?.(undefined);
    pending = undefined;
    readline?.close();
  };
  return {
    interactive,
    write: (message) => console.log(message),
    ask: (question) => {
      if (!interactive || closed) return Promise.resolve(undefined);
      if (!readline) {
        readline = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        readline.once("close", close);
        readline.once("SIGINT", close);
      }
      return new Promise((resolve) => {
        pending = resolve;
        readline!.question(question, (answer) => {
          pending = undefined;
          resolve(answer);
        });
      });
    },
    close,
  };
}

export interface ImportCommandOptions extends Omit<ImportOptions, "apply"> {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}
/** Keep the same preview/apply API for scripts, while making the terminal workflow a single guided command. */
export async function runImportCommand(
  options: ImportCommandOptions,
  io: ImportInteraction,
): Promise<number> {
  if (options.yes && options.dryRun)
    throw new Error("Choose --yes or --dry-run");
  const select = { ...options.select };
  const request = () => ({
    cwd: options.cwd,
    user: options.user,
    home: options.home,
    targets: options.targets,
    outputs: options.outputs,
    exclude: options.exclude,
    select,
  });
  let plan = await importResources(request());
  const guided =
    io.interactive && !options.yes && !options.dryRun && !options.json;
  if (guided) {
    for (const conflict of plan.conflicts) {
      io.write(
        `\nDifferent definitions of ${conflict.key}. Choose the source to keep:`,
      );
      conflict.sources.forEach((source, index) =>
        io.write(`  ${index + 1}. ${source}`),
      );
      while (true) {
        const answer = await io.ask(
          `Source [1-${conflict.sources.length}, or q to cancel]: `,
        );
        if (answer === undefined || answer.trim().toLowerCase() === "q") {
          io.write("Import cancelled. No files changed.");
          return 0;
        }
        const index = /^\d+$/.test(answer.trim())
          ? Number(answer.trim()) - 1
          : -1;
        if (index >= 0 && index < conflict.sources.length) {
          select[conflict.key] = conflict.sources[index]!;
          break;
        }
        io.write("Enter one of the listed numbers, or q to cancel.");
      }
    }
    if (plan.conflicts.length) plan = await importResources(request());
  }
  if (options.expect && options.expect !== plan.id)
    throw new Error(
      "Import plan changed since review; preview again before applying",
    );
  if (
    !options.json ||
    !options.yes ||
    plan.conflicts.length ||
    plan.issues.length
  )
    io.write(
      options.json ? JSON.stringify(plan, null, 2) : describeImport(plan),
    );
  if (plan.conflicts.length || plan.issues.length) return 2;
  if (options.dryRun) return 0;
  if (!options.yes) {
    if (!guided) {
      if (!options.json)
        io.write(
          "\nPreview only. Run import in a terminal to confirm, or use import --yes for unattended setup.",
        );
      return 0;
    }
    const answer = await io.ask(
      "\nBack up the originals and complete this migration? [y/N]: ",
    );
    if (!answer || !["y", "yes"].includes(answer.trim().toLowerCase())) {
      io.write("Import cancelled. No files changed.");
      return 0;
    }
  }
  // The reviewed identifier travels internally. Nobody needs to copy it during normal setup.
  const result = await importResources({
    ...request(),
    apply: true,
    expect: plan.id,
  });
  if (!result.applied) {
    io.write(
      options.json ? JSON.stringify(result, null, 2) : describeImport(result),
    );
    return 2;
  }
  io.write(
    options.json
      ? JSON.stringify(result, null, 2)
      : `\nImport complete. Shared sources and tool configuration are ready.\nOriginals backed up at ${result.backup}\nEdit .agent/ for future changes, then run agent-sync sync.\nReview git diff and commit shared sources with the generated files your team keeps in Git.\nRun agent-sync install-hooks to sync automatically after checkout.`,
  );
  return 0;
}
function describeImport(plan: ImportPlan): string {
  const lines = [
    "Import existing configuration into Agent Sync",
    "",
    "Shared sources to create:",
  ];
  for (const resource of plan.resources)
    lines.push(
      `  ${resource.kind} ${resource.name} -> ${resource.destination}`,
      ...resource.sources.map((source) => `    from ${source}`),
    );
  lines.push(
    "  .agent-sync.yaml selects these sources and target tools.",
    `  Output storage: ${plan.manifest.outputs}. No files are staged or committed automatically.`,
  );
  if (plan.duplicates.length)
    lines.push(
      "",
      `Consolidate ${plan.duplicates.length} group(s) of identical resources.`,
    );
  if (plan.suggestions.length)
    lines.push(
      "",
      "Equivalent resources with different names will keep their names:",
      ...plan.suggestions.map((s) => `  ${s.kind}: ${s.names.join(", ")}`),
    );
  if (plan.outputs.length)
    lines.push(
      "",
      "Tool files after migration:",
      ...plan.outputs.map(
        (file) =>
          `  ${file.action}: ${file.path}${file.reason ? ` — ${file.reason}` : ""}`,
      ),
    );
  if (plan.retained.length)
    lines.push(
      "",
      "Original files kept in place:",
      ...plan.retained.map((path) => `  ${path}`),
    );
  if (plan.excluded.length)
    lines.push(
      "",
      "Explicitly excluded:",
      ...plan.excluded.map((path) => `  ${path}`),
    );
  if (plan.conflicts.length)
    lines.push(
      "",
      "Choose conflicting definitions with --select KIND:NAME=SOURCE:",
      ...plan.conflicts.flatMap((c) => [
        `  ${c.key}`,
        ...c.sources.map((source) => `    ${source}`),
      ]),
    );
  if (plan.issues.length)
    lines.push(
      "",
      "Resolve these before importing:",
      ...plan.issues.map((issue) => `  ${issue.source}: ${issue.message}`),
    );
  if (plan.warnings.length)
    lines.push("", "Notes:", ...plan.warnings.map((warning) => `  ${warning}`));
  if (!plan.conflicts.length && !plan.issues.length)
    lines.push(
      "",
      "On confirmation, Agent Sync backs up existing destinations, creates the shared sources, and updates the tool files above.",
    );
  return lines.join("\n");
}
