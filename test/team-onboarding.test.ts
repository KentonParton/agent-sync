/**
 * Team onboarding regressions through the CLI and onboarding command boundary.
 * Uses disposable real Git repositories and filesystem state; no database is involved.
 * External boundaries mocked: none. Terminal answers are supplied through the command's I/O port.
 * No external checkout, host application, credentials, or network access is required.
 *
 * Covers:
 * - Tracked instructions, tool-specific scope, complete skills, MCP deduplication and retained Cursor files.
 * - Legacy partial setup, cancellation, custom-source protection and hook readiness.
 * - Empty source-directory reuse, empty checkout-hook state and changes during review.
 * - Clean teammate clones, staged/unstaged edits and staged deletions.
 * - Checkout automation, branches without a manifest and independent worktrees.
 * - Hook-manager resets, repeated installation, actual forwarding and edited-wrapper protection.
 * - Machine-readable previews and idempotent setup.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  sync,
  importResources,
  installHooks,
  parseManifest,
} from "../src/index.js";
import { runInitCommand } from "../src/onboarding/command.js";
import type { ImportInteraction } from "../src/import/command.js";

const cli = resolve("dist/cli.js");
// Keep the developer's Git hooks, signing and aliases out of disposable test repos.
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const policy = "# Team\n\nShared development rules.\n";
function command(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, "--cwd", root], {
    encoding: "utf8",
    env: gitEnvironment,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}
function succeeds(root: string, ...args: string[]) {
  const result = command(root, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agent-sync-team-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "--template=", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  return root;
}
async function put(root: string, path: string, text: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
const skill =
  "---\nname: review\ndescription: Review code\n---\nReview behavior.\n";
async function team(
  t: TestContext,
  files: Record<string, string | Buffer> = { "AGENTS.md": policy },
) {
  const root = await fixture(t);
  for (const [path, contents] of Object.entries(files))
    await put(root, path, contents);
  git(root, "add", ".");
  git(root, "commit", "-m", "Existing team config");
  return root;
}
// Frozen files from the old CLI: recovery must not depend on today's starter generator.
const legacyStarter = {
  ".agent-sync.yaml":
    "version: 1\ntargets: [codex, claude, cursor]\ninstructions:\n  - path: .agent/instructions.md\n",
  ".agent/instructions.md":
    "# Repository instructions\n\nDescribe this repository and its development workflow.\n",
};
async function partialSetup(root: string) {
  for (const [path, text] of Object.entries(legacyStarter))
    await put(root, path, text);
}
function interaction(answers: (string | undefined)[] = [], interactive = true) {
  const messages: string[] = [];
  const io: ImportInteraction = {
    interactive,
    write: (m) => messages.push(m),
    ask: async () => answers.shift(),
  };
  return { io, messages };
}
async function onboard(
  t: TestContext,
  files?: Record<string, string | Buffer>,
) {
  const root = await team(t, files);
  succeeds(root, "init", "--yes");
  git(root, "add", ".");
  git(root, "commit", "-m", "Agent Sync sources and outputs");
  return root;
}

test("tracked AGENTS.md is imported without untracking it or staging generated changes", async (t) => {
  const root = await team(t);
  const index = git(root, "ls-files", "--stage");
  const head = git(root, "rev-parse", "HEAD");
  succeeds(root, "init", "--yes");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  assert.equal(git(root, "ls-files", "--stage"), index);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  const manifest = parseManifest(
    await readFile(join(root, ".agent-sync.yaml"), "utf8"),
  );
  assert.equal(manifest.outputs, "committed");
  const instruction = manifest.instructions[0];
  assert.ok(instruction);
  await put(root, instruction.path, "Updated shared policy\n");
  succeeds(root, "sync");
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Updated shared policy\n",
  );
  assert.equal(git(root, "diff", "--name-only"), "AGENTS.md");
});

test("different AGENTS.md and CLAUDE.md retain their instructions and update independently", async (t) => {
  const claude = "Claude-only workflow.\n";
  const root = await team(t, { "AGENTS.md": policy, "CLAUDE.md": claude });
  succeeds(root, "init", "--yes");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), claude);
  const manifest = parseManifest(
    await readFile(join(root, ".agent-sync.yaml"), "utf8"),
  );
  const claudeSource = manifest.instructions.find((i) =>
    i.targets?.includes("claude"),
  );
  assert.ok(claudeSource);
  await put(root, claudeSource.path, "Updated Claude-only workflow.\n");
  succeeds(root, "sync");
  assert.equal(
    await readFile(join(root, "CLAUDE.md"), "utf8"),
    "Updated Claude-only workflow.\n",
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
});

test("one tracked Cursor skill becomes available to every tool with its assets and executable mode", async (t) => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const script = "#!/bin/sh\necho review\n";
  const root = await team(t, {
    ".cursor/skills/review/SKILL.md": skill,
    ".cursor/skills/review/icon.bin": bytes,
    ".cursor/skills/review/run.sh": script,
  });
  await chmod(join(root, ".cursor/skills/review/run.sh"), 0o755);
  git(root, "add", ".");
  git(root, "commit", "-m", "Executable skill resource");
  succeeds(root, "init", "--yes");
  for (const directory of [".agent", ".agents", ".claude", ".cursor"]) {
    assert.equal(
      await readFile(join(root, directory, "skills/review/SKILL.md"), "utf8"),
      skill,
    );
    assert.deepEqual(
      await readFile(join(root, directory, "skills/review/icon.bin")),
      bytes,
    );
    assert.equal(
      await readFile(join(root, directory, "skills/review/run.sh"), "utf8"),
      script,
    );
    assert.ok(
      (await stat(join(root, directory, "skills/review/run.sh"))).mode & 0o111,
    );
  }
  const repeated = JSON.parse(succeeds(root, "sync"));
  assert.ok(repeated.changes.length > 0);
  assert.ok(
    repeated.changes.every((c: { action: string }) => c.action === "unchanged"),
  );
});

test("Cursor scoped rules and commands stay intact and are reported as untranslated", async (t) => {
  const rule =
    "---\nglobs: frontend/**\nalwaysApply: false\n---\nFrontend only.\n";
  const customCommand = "Plan the change without implementing it.\n";
  const root = await team(t, {
    "AGENTS.md": policy,
    ".cursor/rules/frontend.mdc": rule,
    ".cursor/commands/plan.md": customCommand,
  });
  const report = JSON.parse(succeeds(root, "init", "--yes", "--json"));
  assert.ok(report.retained.includes("project:.cursor/rules/frontend.mdc"));
  assert.ok(report.retained.includes("project:.cursor/commands/plan.md"));
  assert.ok(report.warnings.some((w: string) => w.includes("not translated")));
  succeeds(root, "sync");
  assert.equal(
    await readFile(join(root, ".cursor/rules/frontend.mdc"), "utf8"),
    rule,
  );
  assert.equal(
    await readFile(join(root, ".cursor/commands/plan.md"), "utf8"),
    customCommand,
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
});

test("equivalent Codex and Claude MCP definitions consolidate into one shared server", async (t) => {
  const root = await team(t, {
    ".codex/config.toml":
      '[mcp_servers.devtools]\ncommand="node"\nargs=["server.js"]\n',
    ".mcp.json":
      '{"mcpServers":{"devtools":{"command":"node","args":["server.js"]}}}\n',
  });
  succeeds(root, "init", "--yes");
  const canonical = JSON.parse(
    await readFile(join(root, ".agent/mcp.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(canonical.mcpServers), ["devtools"]);
  assert.equal(canonical.mcpServers.devtools.command, "node");
  canonical.mcpServers.devtools.args = ["new-server.js"];
  await put(root, ".agent/mcp.json", JSON.stringify(canonical));
  succeeds(root, "sync");
  for (const path of [".mcp.json", ".cursor/mcp.json"]) {
    const output = JSON.parse(await readFile(join(root, path), "utf8"));
    assert.deepEqual(Object.keys(output.mcpServers), ["devtools"]);
    assert.deepEqual(output.mcpServers.devtools.args, ["new-server.js"]);
  }
  assert.match(
    await readFile(join(root, ".codex/config.toml"), "utf8"),
    /new-server\.js/,
  );
});

test("init previews an existing team repo in scripts and cancellation leaves no state", async (t) => {
  const root = await team(t);
  assert.equal(
    await runInitCommand({ cwd: root }, interaction([], false).io),
    0,
  );
  assert.equal(await runInitCommand({ cwd: root }, interaction(["n"]).io), 0);
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
  await assert.rejects(readdir(join(root, ".git/agent-sync")));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("init recovers the earlier untouched starter and leaves existing hooks intact", async (t) => {
  const root = await team(t);
  await partialSetup(root);
  await put(root, ".git/agent-sync/candidate.json", "{}");
  const previousHook = "#!/bin/sh\nexit 0\n";
  const hooks = join(root, ".git/agent-sync/hooks");
  await put(root, ".git/agent-sync/hooks/post-checkout", previousHook);
  await chmod(join(hooks, "post-checkout"), 0o755);
  await put(
    root,
    ".git/agent-sync/hook-install.json",
    JSON.stringify({ hooks, content: previousHook }),
  );
  git(root, "config", "core.hooksPath", hooks);
  const initial = await readFile(join(root, ".agent-sync.yaml"), "utf8");
  const preview = await importResources({ cwd: root });
  assert.equal(preview.recoveringStarter, true);
  assert.equal(await runInitCommand({ cwd: root }, interaction(["n"]).io), 0);
  assert.equal(await readFile(join(root, ".agent-sync.yaml"), "utf8"), initial);
  succeeds(root, "init", "--yes");
  assert.equal(
    await readFile(join(root, ".git/agent-sync/hooks/post-checkout"), "utf8"),
    previousHook,
  );
  assert.equal(git(root, "config", "--get", "core.hooksPath"), hooks);
  const backupDirectory = join(root, ".git/agent-sync/backups");
  const backupName = (await readdir(backupDirectory)).find((p) =>
    p.startsWith("starter-"),
  );
  assert.ok(backupName);
  const backup = JSON.parse(
    await readFile(join(backupDirectory, backupName), "utf8"),
  );
  for (const [path, original] of Object.entries(legacyStarter))
    assert.equal(
      Buffer.from(backup[path].content, "base64").toString(),
      original,
    );
  assert.equal((await sync({ cwd: root })).applied, true);
  succeeds(root, "install-hooks");
  git(root, "checkout", "-b", "after-recovery");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  await assert.rejects(readFile(join(root, ".agent/instructions.md")), {
    code: "ENOENT",
  });
});

test("edited starters and extra source files are not replaced by import", async (t) => {
  for (const extra of [false, true]) {
    const root = await team(t);
    await partialSetup(root);
    await put(
      root,
      extra ? ".agent/my-policy.md" : ".agent/instructions.md",
      "Custom policy",
    );
    const result = await importResources({ cwd: root, apply: true });
    assert.equal(result.applied, false);
    assert.equal(result.recoveringStarter, false);
    assert.equal(
      await readFile(
        join(root, extra ? ".agent/my-policy.md" : ".agent/instructions.md"),
        "utf8",
      ),
      "Custom policy",
    );
  }
});

test("empty init starts a project and hooks require edited, successfully synced instructions", async (t) => {
  const root = await fixture(t);
  assert.equal(
    await runInitCommand({ cwd: root, dryRun: true }, interaction().io),
    0,
  );
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
  assert.equal(await runInitCommand({ cwd: root }, interaction().io), 0);
  await assert.rejects(sync({ cwd: root }), /starter instructions/);
  await assert.rejects(installHooks(root, cli), /Finish setup/);
  await put(root, ".agent/instructions.md", "Our policy");
  await sync({ cwd: root });
  assert.equal((await installHooks(root, cli)).installed, true);
});

test("a teammate can init a clean clone without an ownership ledger or import", async (t) => {
  const root = await onboard(t);
  const parent = await fixture(t),
    clone = join(parent, "clone");
  git(parent, "clone", "--quiet", root, clone);
  const { io, messages } = interaction([], false);
  assert.equal(
    await runInitCommand({ cwd: clone, yes: true, json: true }, io),
    0,
  );
  assert.equal(JSON.parse(messages.join("\n")).applied, true);
  assert.equal(git(clone, "status", "--porcelain"), "");
  assert.ok(
    (await sync({ cwd: clone })).changes.every((c) => c.action === "unchanged"),
  );
});

for (const staged of [false, true]) {
  test(`fresh clone preserves ${staged ? "staged" : "unstaged"} output edits`, async (t) => {
    const root = await onboard(t);
    const parent = await fixture(t),
      clone = join(parent, "clone");
    git(parent, "clone", "--quiet", root, clone);
    await put(clone, "AGENTS.md", "Local changes");
    if (staged) git(clone, "add", "AGENTS.md");
    const result = await sync({ cwd: clone });
    assert.equal(result.applied, false);
    assert.equal(
      await readFile(join(clone, "AGENTS.md"), "utf8"),
      "Local changes",
    );
    await assert.rejects(installHooks(clone, cli), /Finish setup/);
  });
}

test("checkout after repeated hook installation actually regenerates changed source instructions", async (t) => {
  const root = await onboard(t);
  git(root, "checkout", "-b", "updated");
  const manifest = parseManifest(
    await readFile(join(root, ".agent-sync.yaml"), "utf8"),
  );
  const instruction = manifest.instructions[0];
  assert.ok(instruction);
  await put(root, instruction.path, "New branch policy\n");
  git(root, "add", instruction.path);
  git(root, "commit", "-m", "Change source without regenerating output");
  git(root, "checkout", "main");
  await put(
    root,
    ".git/hooks/post-checkout",
    '#!/bin/sh\necho previous >> "$(git rev-parse --git-path checkout-runs)"\n',
  );
  await chmod(join(root, ".git/hooks/post-checkout"), 0o755);
  succeeds(root, "install-hooks");
  succeeds(root, "install-hooks");
  git(root, "checkout", "updated");
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "New branch policy\n",
  );
  assert.equal(
    await readFile(join(root, ".git/checkout-runs"), "utf8"),
    "previous\n",
  );
});

test("checking out a branch without a manifest retains its tracked instructions", async (t) => {
  const root = await onboard(t);
  const legacy = git(root, "rev-parse", "HEAD~1");
  succeeds(root, "install-hooks");
  git(root, "checkout", "--detach", legacy);
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  assert.equal(git(root, "status", "--porcelain"), "");
  git(root, "checkout", "main");
  succeeds(root, "sync");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a linked worktree syncs independently of local edits in the original checkout", async (t) => {
  const root = await onboard(t);
  const parent = await fixture(t),
    worktree = join(parent, "worktree");
  git(root, "worktree", "add", "--detach", worktree, "main");
  await put(root, "AGENTS.md", "Local main-checkout edit\n");
  succeeds(worktree, "init", "--yes");
  assert.equal(await readFile(join(worktree, "AGENTS.md"), "utf8"), policy);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(command(root, "sync").status, 2);
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Local main-checkout edit\n",
  );
});

test("init CLI returns one JSON document and install-hooks refuses incomplete setup", async (t) => {
  const root = await team(t);
  const call = (...args: string[]) => command(root, ...args);
  assert.equal(call("install-hooks").status, 1);
  const preview = call("init", "--dry-run", "--json");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  const result = call("init", "--yes", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, true);
  const again = call("init", "--yes", "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).applied, true);
});

test("hook installation can rejoin a reset hook manager without changing its scripts", async (t) => {
  const root = await onboard(t);
  const original =
    '#!/bin/sh\necho team-hook >> "$(git rev-parse --git-path pre-commit-runs)"\n';
  await put(root, "scripts/git-hooks/pre-commit", original);
  await chmod(join(root, "scripts/git-hooks/pre-commit"), 0o755);
  git(root, "config", "core.hooksPath", "./scripts/git-hooks");
  const installed = await installHooks(root, cli);
  assert.equal(installed.installed, true);
  git(root, "hook", "run", "pre-commit");
  assert.equal(
    await readFile(join(root, ".git/pre-commit-runs"), "utf8"),
    "team-hook\n",
  );
  assert.equal((await installHooks(root, cli)).installed, false);
  git(root, "config", "core.hooksPath", "./scripts/git-hooks");
  assert.equal((await installHooks(root, cli)).installed, true);
  git(root, "hook", "run", "pre-commit");
  assert.equal(
    await readFile(join(root, ".git/pre-commit-runs"), "utf8"),
    "team-hook\nteam-hook\n",
  );
  assert.equal(
    await readFile(join(root, "scripts/git-hooks/pre-commit"), "utf8"),
    original,
  );
  await put(root, ".git/agent-sync/hooks/pre-commit", "user customization");
  await assert.rejects(installHooks(root, cli), /edited locally/);
  assert.equal(
    await readFile(join(root, ".git/agent-sync/hooks/pre-commit"), "utf8"),
    "user customization",
  );
});

test("dropping a committed resource on another branch does not conflict with Git removing it", async (t) => {
  const root = await onboard(t, {
    "AGENTS.md": policy,
    ".mcp.json": '{"mcpServers":{"devtools":{"command":"node"}}}\n',
  });
  git(root, "checkout", "-b", "without-mcp");
  const manifest = await readFile(join(root, ".agent-sync.yaml"), "utf8");
  await put(
    root,
    ".agent-sync.yaml",
    manifest.replace(/mcp:\n  - path: .agent\/mcp.json\n/, "mcp: []\n"),
  );
  git(
    root,
    "rm",
    ".mcp.json",
    ".codex/config.toml",
    ".cursor/mcp.json",
    ".agent/mcp.json",
  );
  git(root, "add", ".agent-sync.yaml");
  git(root, "commit", "-m", "Drop MCP on this branch");
  const result = await sync({ cwd: root });
  assert.equal(result.applied, true);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("staged deletions in a fresh clone are preserved instead of recreated", async (t) => {
  const root = await onboard(t);
  const parent = await fixture(t),
    clone = join(parent, "clone");
  git(parent, "clone", "--quiet", root, clone);
  git(clone, "rm", "AGENTS.md");
  const result = await sync({ cwd: clone });
  assert.equal(result.applied, false);
  assert.match(
    result.changes.find((c) => c.path === "AGENTS.md")?.reason ?? "",
    /Staged deletion/,
  );
  await assert.rejects(readFile(join(clone, "AGENTS.md")));
});

test("init --json previews an empty repository without creating files", async (t) => {
  const root = await fixture(t);
  const { io, messages } = interaction([], false);
  assert.equal(await runInitCommand({ cwd: root, json: true }, io), 0);
  assert.equal(JSON.parse(messages.join("\n")).applied, false);
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
});

test("init reuses an empty .agent directory without replacing it", async (t) => {
  const root = await team(t);
  await mkdir(join(root, ".agent"));
  const before = await stat(join(root, ".agent"));
  const preview = JSON.parse(succeeds(root, "init", "--dry-run", "--json"));
  assert.deepEqual(preview.issues, []);
  assert.deepEqual(await readdir(join(root, ".agent")), []);
  succeeds(root, "init", "--yes");
  assert.equal((await stat(join(root, ".agent"))).ino, before.ino);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  succeeds(root, "sync");
});

test("init accepts empty sync state left by a checkout hook before onboarding", async (t) => {
  const root = await team(t);
  succeeds(root, "sync", "--hook");
  const statePath = join(root, ".git/agent-sync/active.json");
  const before = await readFile(statePath, "utf8");
  assert.deepEqual(JSON.parse(before).files, {});
  const preview = JSON.parse(succeeds(root, "init", "--dry-run", "--json"));
  assert.deepEqual(preview.issues, []);
  assert.equal(await readFile(statePath, "utf8"), before);
  succeeds(root, "init", "--yes");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), policy);
  const result = await sync({ cwd: root });
  assert.equal(result.applied, true);
  assert.ok(result.changes.every((change) => change.action === "unchanged"));
  assert.ok(
    Object.keys(JSON.parse(await readFile(statePath, "utf8")).files).length > 0,
  );
  const repeat = await importResources({ cwd: root });
  assert.ok(
    repeat.issues.some((issue) =>
      /already has import or sync state/.test(issue.message),
    ),
  );
});

test("a source added to an empty .agent directory after review blocks import", async (t) => {
  const root = await team(t);
  await mkdir(join(root, ".agent"));
  const preview = await importResources({ cwd: root });
  assert.deepEqual(preview.issues, []);
  await put(root, ".agent/.private-policy", "Preserve this source");
  await assert.rejects(
    importResources({ cwd: root, apply: true, expect: preview.id }),
    /changed since review/,
  );
  assert.equal(
    await readFile(join(root, ".agent/.private-policy"), "utf8"),
    "Preserve this source",
  );
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")), {
    code: "ENOENT",
  });
});
