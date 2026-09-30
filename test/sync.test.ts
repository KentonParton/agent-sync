import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  sync,
  parseManifest,
  installHooks,
  promote,
  merge,
  activate,
} from "../src/index.js";
import TOML from "@iarna/toml";
const cli = resolve("dist/cli.js");
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  return realpath(root);
}
const instructions =
  "version: 1\ninstructions:\n  - path: .agent/instructions.md\n";
const skill =
  "---\nname: review\ndescription: Review changes\n---\nCheck behavior.\n";
const portable = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "team-tools",
  version: "1.0.0",
});

test("creates cross-harness instructions, binary skill resources and MCP with runtime secrets", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    instructions +
      "skills:\n  - path: .agent/skills\nmcp:\n  - path: .agent/mcp.json\n",
  );
  await put(root, ".agent/instructions.md", "Team instructions\n");
  await put(root, ".agent/skills/review/SKILL.md", skill);
  const bytes = Buffer.from([0, 255, 128, 10]);
  await put(root, ".agent/skills/review/data.bin", bytes);
  await put(
    root,
    ".agent/mcp.json",
    JSON.stringify({
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          envFrom: { TOKEN: "TOKEN" },
        },
        remote: { url: "https://example.com/mcp", bearerTokenEnv: "API_TOKEN" },
      },
    }),
  );
  const result = await sync({ cwd: root });
  assert.equal(result.applied, true);
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Team instructions\n",
  );
  assert.match(await readFile(join(root, "CLAUDE.md"), "utf8"), /@AGENTS.md/);
  for (const directory of [".agents", ".claude", ".cursor"])
    assert.deepEqual(
      await readFile(join(root, directory, "skills/review/data.bin")),
      bytes,
    );
  const codex = TOML.parse(
    await readFile(join(root, ".codex/config.toml"), "utf8"),
  ) as any;
  assert.deepEqual(codex.mcp_servers.local.env_vars, ["TOKEN"]);
  assert.equal(codex.mcp_servers.remote.bearer_token_env_var, "API_TOKEN");
  const cursor = JSON.parse(
    await readFile(join(root, ".cursor/mcp.json"), "utf8"),
  );
  assert.equal(cursor.mcpServers.local.env.TOKEN, "${env:TOKEN}");
  assert.ok(
    (await sync({ cwd: root })).changes.every((c) => c.action === "unchanged"),
  );
});
test("all outputs remain unchanged on conflict; replace backs up only owned files", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Before");
  await sync({ cwd: root });
  await put(root, "AGENTS.md", "Local edit");
  await put(root, ".agent/instructions.md", "After");
  const result = await sync({ cwd: root });
  assert.equal(result.applied, false);
  assert.equal(
    result.changes.find((c) => c.path === "AGENTS.md")?.action,
    "conflict",
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Local edit");
  assert.equal(
    (await sync({ cwd: root, replace: ["AGENTS.md"] })).applied,
    true,
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "After\n");
  const { readdir } = await import("node:fs/promises");
  assert.equal(
    (await readdir(join(root, ".git/agent-sync/backups"))).length,
    1,
  );
});
test("never adopts an existing file, even when content matches or replace is requested", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Existing");
  await put(root, "AGENTS.md", "Existing\n");
  await assert.rejects(
    sync({ cwd: root, replace: ["AGENTS.md"] }),
    /not owned/,
  );
  const result = await sync({ cwd: root });
  assert.equal(result.applied, false);
  assert.match(result.changes[0]!.reason!, /not owned/);
  await assert.rejects(readFile(join(root, "CLAUDE.md")));
});
test("tracked outputs are protected even if originally generated", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "First");
  await sync({ cwd: root });
  git(root, "add", "AGENTS.md");
  await put(root, ".agent/instructions.md", "Second");
  assert.equal(
    (await sync({ cwd: root, replace: ["AGENTS.md"] })).applied,
    false,
  );
});
test("dry run writes no generated outputs or active baseline", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Test");
  const result = await sync({ cwd: root, dryRun: true });
  assert.equal(result.applied, false);
  assert.equal(result.changes[0]?.action, "create");
  await assert.rejects(readFile(join(root, "AGENTS.md")));
  await assert.rejects(readFile(join(root, ".git/agent-sync/active.json")));
});
test("preserves local deletions and executable changes", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Test");
  await sync({ cwd: root });
  await rm(join(root, "AGENTS.md"));
  assert.equal(
    (await sync({ cwd: root })).changes.find((c) => c.path === "AGENTS.md")
      ?.action,
    "conflict",
  );
  await sync({ cwd: root, replace: ["AGENTS.md"] });
  await chmod(join(root, "AGENTS.md"), 0o700);
  assert.equal(
    (await sync({ cwd: root })).changes.find((c) => c.path === "AGENTS.md")
      ?.action,
    "conflict",
  );
});
test("rejects symlink sources and destination parents without following them", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await put(outside, "instructions", "Private");
  await put(root, ".agent-sync.yaml", instructions);
  await mkdir(join(root, ".agent"));
  await symlink(
    join(outside, "instructions"),
    join(root, ".agent/instructions.md"),
  );
  await assert.rejects(sync({ cwd: root }), /symlink/);
  await rm(join(root, ".agent/instructions.md"));
  await put(root, ".agent/instructions.md", "Safe");
  await symlink(join(outside, "instructions"), join(root, "AGENTS.md"));
  assert.equal((await sync({ cwd: root })).applied, false);
  assert.equal(
    await readFile(join(outside, "instructions"), "utf8"),
    "Private",
  );
});
test("removes only clean owned outputs when a branch drops a resource", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Test");
  await sync({ cwd: root });
  await put(root, ".cursor/personal.json", "mine");
  await put(root, ".agent-sync.yaml", "version: 1\n");
  const result = await sync({ cwd: root });
  assert.ok(result.changes.every((c) => c.action === "remove"));
  await assert.rejects(readFile(join(root, "AGENTS.md")));
  assert.equal(
    await readFile(join(root, ".cursor/personal.json"), "utf8"),
    "mine",
  );
});
test("resolves Git sources by ref, preserves binary bytes, and supports verified offline cache", async (t) => {
  const source = await fixture(t);
  await put(source, "policy.md", "Remote policy\n\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial");
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    `instructions:\n  - source: ${JSON.stringify(source)}\n    ref: main\n    path: policy.md\n`,
  );
  await sync({ cwd: root });
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Remote policy\n",
  );
  await put(source, "policy.md", "Updated policy");
  git(source, "add", ".");
  git(source, "commit", "-m", "Update");
  await sync({ cwd: root, offline: true });
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Remote policy\n",
  );
  await sync({ cwd: root });
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Updated policy\n",
  );
});
test("switching Git refs uses a separate offline cache", async (t) => {
  const source = await fixture(t);
  await put(source, "policy.md", "main");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial");
  const root = await fixture(t);
  const manifest = (ref: string) =>
    `instructions:\n  - source: ${JSON.stringify(source)}\n    ref: ${ref}\n    path: policy.md\n`;
  await put(root, ".agent-sync.yaml", manifest("main"));
  await sync({ cwd: root });
  await put(root, ".agent-sync.yaml", manifest("missing"));
  await assert.rejects(
    sync({ cwd: root, offline: true }),
    /No verified offline cache/,
  );
});
test("post-checkout runs actual CLI, preserves existing hooks and switches branch content", async (t) => {
  const root = await fixture(t);
  await put(root, ".gitignore", "AGENTS.md\nCLAUDE.md\n");
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Main");
  git(root, "add", ".");
  git(root, "commit", "-m", "Main");
  git(root, "checkout", "-b", "second");
  await put(root, ".agent/instructions.md", "Second");
  git(root, "add", ".");
  git(root, "commit", "-m", "Second");
  await put(
    root,
    ".git/hooks/post-checkout",
    '#!/bin/sh\nprintf "previous hook\\n" >> previous.log\n',
  );
  await chmod(join(root, ".git/hooks/post-checkout"), 0o755);
  await sync({ cwd: root });
  await installHooks(root, cli);
  await installHooks(root, cli);
  git(root, "checkout", "main");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Main\n");
  git(root, "checkout", "second");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Second\n");
  assert.equal(
    (await readFile(join(root, "previous.log"), "utf8"))
      .split("\n")
      .filter(Boolean).length,
    2,
  );
});
test("linked worktrees have independent baselines", async (t) => {
  const root = await fixture(t);
  await put(root, ".gitignore", "AGENTS.md\nCLAUDE.md\n");
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Main");
  git(root, "add", ".");
  git(root, "commit", "-m", "Main");
  const worktree = root + "-worktree";
  t.after(() => rm(worktree, { recursive: true, force: true }));
  git(root, "worktree", "add", "-b", "other", worktree);
  await put(worktree, ".agent/instructions.md", "Other");
  const a = await sync({ cwd: root });
  const b = await sync({ cwd: worktree });
  assert.notEqual(a.stateDir, b.stateDir);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Main\n");
  assert.equal(await readFile(join(worktree, "AGENTS.md"), "utf8"), "Other\n");
});
test("native plugins remain complete units and portable mode installs standard components", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    "plugins:\n  - path: .agent/plugin\n    mode: portable\n",
  );
  await put(root, ".agent/plugin/plugin.json", portable);
  await put(root, ".agent/plugin/skills/review/SKILL.md", skill);
  await put(root, ".agent/plugin/scripts/data.bin", Buffer.from([0, 255, 3]));
  await sync({ cwd: root });
  assert.match(
    await readFile(
      join(root, ".agents/skills/team-tools-review/SKILL.md"),
      "utf8",
    ),
    /name: team-tools-review/,
  );
  assert.deepEqual(
    await readFile(
      join(root, ".agent-sync/plugins/team-tools/scripts/data.bin"),
    ),
    Buffer.from([0, 255, 3]),
  );
  await put(root, ".agent-sync.yaml", "plugins:\n  - path: .agent/plugin\n");
  await sync({ cwd: root });
  assert.equal(
    await readFile(
      join(root, ".claude/skills/team-tools/skills/review/SKILL.md"),
      "utf8",
    ),
    skill,
  );
  assert.ok(
    JSON.parse(
      await readFile(join(root, ".agents/plugins/marketplace.json"), "utf8"),
    ).plugins.length,
  );
});
test("unsupported native target fails before any output writes", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    instructions + "plugins:\n  - path: .agent/plugin\n",
  );
  await put(root, ".agent/instructions.md", "Policy");
  await put(
    root,
    ".agent/plugin/.claude-plugin/plugin.json",
    '{"name":"claude-only"}',
  );
  await assert.rejects(sync({ cwd: root }), /no codex build/);
  await assert.rejects(readFile(join(root, "AGENTS.md")));
});
test("Cursor activation keeps full packages and protects edits across branch updates", async (t) => {
  const root = await fixture(t);
  const home = join(root, ".test-cursor");
  await put(
    root,
    ".agent-sync.yaml",
    "plugins:\n  - path: .agent/plugin\n    targets: [cursor]\n",
  );
  await put(root, ".agent/plugin/plugin.json", portable);
  await put(root, ".agent/plugin/skills/review/SKILL.md", skill);
  await sync({ cwd: root });
  await activate("cursor", { cwd: root, home });
  const { readdir } = await import("node:fs/promises");
  const installed = (await readdir(join(home, "plugins/local")))[0]!;
  await put(root, ".agent/plugin/skills/review/SKILL.md", skill + "Updated\n");
  await sync({ cwd: root });
  assert.match(
    await readFile(
      join(home, "plugins/local", installed, "skills/review/SKILL.md"),
      "utf8",
    ),
    /Updated/,
  );
  await put(
    home,
    `plugins/local/${installed}/skills/review/SKILL.md`,
    "Local edit",
  );
  await put(
    root,
    ".agent/plugin/skills/review/SKILL.md",
    skill + "New upstream\n",
  );
  await assert.rejects(sync({ cwd: root }), /changes preserved/);
  assert.equal(
    await readFile(
      join(home, "plugins/local", installed, "skills/review/SKILL.md"),
      "utf8",
    ),
    "Local edit",
  );
});
test("prepares a contribution branch at owning Git source without modifying source or publishing", async (t) => {
  const source = await fixture(t);
  await put(source, "policy.md", "Original policy\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial");
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    `instructions:\n  - source: ${JSON.stringify(source)}\n    ref: main\n    path: policy.md\n`,
  );
  await sync({ cwd: root });
  await put(root, "AGENTS.md", "Improved policy\n");
  const result = await promote("AGENTS.md", { cwd: root });
  assert.match(result.branch, /^codex\//);
  assert.equal(
    await readFile(join(result.checkout, "policy.md"), "utf8"),
    "Improved policy\n",
  );
  assert.equal(
    await readFile(join(source, "policy.md"), "utf8"),
    "Original policy\n",
  );
  assert.match(await readFile(result.patchPath, "utf8"), /Improved policy/);
  assert.equal(result.pullRequest, undefined);
});
test("ambiguous instruction promotion requires selecting the owning fragment", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    "instructions:\n  - path: one.md\n  - path: two.md\n",
  );
  await put(root, "one.md", "One");
  await put(root, "two.md", "Two");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  await sync({ cwd: root });
  await put(
    root,
    "AGENTS.md",
    "Changed one\n\n<!-- agent-sync -->\n\nChanged two\n",
  );
  await assert.rejects(promote("AGENTS.md", { cwd: root }), /source-index/);
  const result = await promote("AGENTS.md", { cwd: root, sourceIndex: 1 });
  assert.equal(
    await readFile(join(result.checkout, "two.md"), "utf8"),
    "Changed two\n",
  );
  assert.equal(await readFile(join(result.checkout, "one.md"), "utf8"), "One");
});
test("merge keeps conflicting local content and writes conflict markers separately", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Before");
  await sync({ cwd: root });
  await put(root, "AGENTS.md", "Local\n");
  await put(root, ".agent/instructions.md", "Upstream");
  await sync({ cwd: root });
  const result = await merge("AGENTS.md", root);
  assert.equal(result.conflicted, true);
  assert.match(await readFile(result.resultPath, "utf8"), /<<<<<<< local/);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Local\n");
});
test("validation rejects unknown fields, duplicate YAML keys, traversal and unsafe Git transport", () => {
  for (const input of [
    "skillz: []",
    "version: 1\nversion: 1",
    "instructions:\n - path: ../secret",
    "instructions:\n - source: ext::evil\n   path: a",
    "targets: [codex, codex]",
  ])
    assert.throws(() => parseManifest(input));
});
test("name collisions fail without installing partial skills", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", "skills:\n - path: one\n - path: two\n");
  await put(root, "one/review/SKILL.md", skill);
  await put(root, "two/review/SKILL.md", skill);
  await assert.rejects(sync({ cwd: root }), /Multiple resources/);
  await assert.rejects(readFile(join(root, ".agents/skills/review/SKILL.md")));
});
test("MCP promotion reverses host environment references without embedding secrets", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", "mcp:\n  - path: .agent/mcp.json\n");
  await put(
    root,
    ".agent/mcp.json",
    '{"mcpServers":{"api":{"url":"https://example.com/mcp","bearerTokenEnv":"TOKEN"}}}',
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  await sync({ cwd: root });
  await put(
    root,
    ".cursor/mcp.json",
    '{"mcpServers":{"api":{"url":"https://example.com/v2/mcp","headers":{"Authorization":"Bearer ${env:TOKEN}"}}}}',
  );
  const result = await promote(".cursor/mcp.json", { cwd: root });
  const source = JSON.parse(
    await readFile(join(result.checkout, ".agent/mcp.json"), "utf8"),
  );
  assert.equal(source.mcpServers.api.bearerTokenEnv, "TOKEN");
  assert.equal(source.mcpServers.api.url, "https://example.com/v2/mcp");
});
test("catalog include keeps selected plugins complete", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    "plugins:\n - catalog: .claude-plugin/marketplace.json\n   include: [team-tools]\n   mode: portable\n",
  );
  await put(
    root,
    ".claude-plugin/marketplace.json",
    '{"name":"team","plugins":[{"name":"team-tools","source":"./packages/team"},{"name":"unused","source":"./packages/missing"}]}',
  );
  await put(root, "packages/team/plugin.json", portable);
  await put(root, "packages/team/skills/review/SKILL.md", skill);
  assert.equal((await sync({ cwd: root })).applied, true);
  assert.equal(
    await readFile(
      join(root, ".agent-sync/plugins/team-tools/skills/review/SKILL.md"),
      "utf8",
    ),
    skill,
  );
});
test("portable plugin MCP emits rooted paths and normalized transport", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    "plugins:\n - path: .agent/plugin\n   mode: portable\n",
  );
  await put(root, ".agent/plugin/plugin.json", portable);
  await put(
    root,
    ".agent/plugin/mcp.json",
    '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"local":{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/server.js"]}}}',
  );
  await put(root, ".agent/plugin/server.js", "// test");
  await sync({ cwd: root });
  const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.equal(
    config.mcpServers["team-tools-local"].args[0],
    join(root, ".agent-sync/plugins/team-tools/server.js"),
  );
});
test("an interrupted journal blocks another sync without overwriting outputs", async (t) => {
  const root = await fixture(t);
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "First");
  await sync({ cwd: root });
  await put(root, ".git/agent-sync/journal.json", "{}");
  await put(root, ".agent/instructions.md", "Second");
  await assert.rejects(sync({ cwd: root }), /interrupted transaction/);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "First\n");
});
test("generated hook leaves branch checkout successful when edits conflict", async (t) => {
  const root = await fixture(t);
  await put(root, ".gitignore", "AGENTS.md\nCLAUDE.md\n");
  await put(root, ".agent-sync.yaml", instructions);
  await put(root, ".agent/instructions.md", "Main");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  await sync({ cwd: root });
  await installHooks(root, cli);
  await put(root, "AGENTS.md", "Local");
  git(root, "checkout", "-b", "next");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Local");
});
test(
  "installed Codex CLI activates, refreshes and removes complete native packages",
  { skip: !process.env.AGENT_SYNC_TEST_CODEX },
  async (t) => {
    const root = await fixture(t);
    const home = join(root, ".test-codex");
    await put(
      root,
      ".agent-sync.yaml",
      "plugins:\n - path: .agent/plugin\n   targets: [codex]\n",
    );
    await put(root, ".agent/plugin/plugin.json", portable);
    await put(root, ".agent/plugin/skills/review/SKILL.md", skill);
    await sync({ cwd: root });
    await activate("codex", { cwd: root, home });
    let record = JSON.parse(
      await readFile(
        join(root, ".git/agent-sync/activation-codex.json"),
        "utf8",
      ),
    );
    const installedPath = join(
      home,
      record.installed["team-tools"].path,
      "skills/review/SKILL.md",
    );
    assert.equal(await readFile(installedPath, "utf8"), skill);
    await put(
      root,
      ".agent/plugin/skills/review/SKILL.md",
      skill + "Updated\n",
    );
    await sync({ cwd: root });
    assert.match(await readFile(installedPath, "utf8"), /Updated/);
    await writeFile(installedPath, "Local change");
    await assert.rejects(sync({ cwd: root }), /Local edits in installed Codex/);
    assert.equal(await readFile(installedPath, "utf8"), "Local change");
    await writeFile(installedPath, skill + "Updated\n");
    await put(root, ".agent-sync.yaml", "version: 1\n");
    await sync({ cwd: root });
    record = JSON.parse(
      await readFile(
        join(root, ".git/agent-sync/activation-codex.json"),
        "utf8",
      ),
    );
    assert.equal(Object.keys(record.installed).length, 0);
    await assert.rejects(readFile(installedPath));
  },
);
test("portable skill promotion restores the source name without losing the local change", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    "plugins:\n - path: .agent/plugin\n   mode: portable\n",
  );
  await put(root, ".agent/plugin/plugin.json", portable);
  await put(root, ".agent/plugin/skills/review/SKILL.md", skill);
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  await sync({ cwd: root });
  const path = ".agents/skills/team-tools-review/SKILL.md";
  const current = await readFile(join(root, path), "utf8");
  await put(root, path, current + "An improvement\n");
  const result = await promote(path, { cwd: root });
  const updated = await readFile(
    join(result.checkout, ".agent/plugin/skills/review/SKILL.md"),
    "utf8",
  );
  assert.match(updated, /name: review/);
  assert.doesNotMatch(updated, /name: team-tools-review/);
  assert.match(updated, /An improvement/);
});
test("publishes only a new review branch and passes exact PR text through a body file", async (t) => {
  const source = await fixture(t);
  await put(source, "policy.md", "Original\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial");
  const root = await fixture(t);
  await put(
    root,
    ".agent-sync.yaml",
    `instructions:\n - source: ${JSON.stringify(source)}\n   ref: main\n   path: policy.md\n`,
  );
  await sync({ cwd: root });
  await put(root, "AGENTS.md", "Improvement\n");
  const bin = join(root, "test-bin");
  await put(
    root,
    "test-bin/gh",
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--body-file" ]; then shift; cp "$1" "' +
      root +
      '/captured-body"; fi\n shift\ndone\nprintf "https://github.com/example/test/pull/1\\n"\n',
  );
  await chmod(join(bin, "gh"), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: bin + ":" + process.env.PATH,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  try {
    const body = "First line\n\nLiteral `command` and $(no-execution).\n";
    const result = await promote("AGENTS.md", {
      cwd: root,
      publish: true,
      body,
      branch: "codex/test-contribution",
    });
    assert.equal(result.pullRequest, "https://github.com/example/test/pull/1");
    assert.equal(await readFile(join(root, "captured-body"), "utf8"), body);
    assert.equal(git(source, "show", "main:policy.md"), "Original");
    assert.equal(
      git(source, "show", "codex/test-contribution:policy.md"),
      "Improvement",
    );
    await assert.rejects(
      promote("AGENTS.md", { cwd: root, branch: "codex/test-contribution" }),
      /already exists/,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
