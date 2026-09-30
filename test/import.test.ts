import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { importResources, sync, parseManifest } from "../src/index.js";
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agent-sync-import-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  return root;
}
async function put(root: string, path: string, text: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
const skill =
  "---\nname: review\ndescription: Review a change\n---\nCheck behavior.\n";
const plugin =
  '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"team-tools"}';

test("import previews without writes and normalizes/deduplicates all supported MCP hosts", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".codex/config.toml",
    '[mcp_servers.api]\ncommand="node"\nargs=["server.js"]\nenv_vars=["TOKEN"]\n',
  );
  await put(
    root,
    ".mcp.json",
    '{"mcpServers":{"api":{"type":"stdio","command":"node","args":["server.js"],"env":{"TOKEN":"${TOKEN}"}}}}',
  );
  await put(
    root,
    ".cursor/mcp.json",
    '{"mcpServers":{"api":{"command":"node","args":["server.js"],"env":{"TOKEN":"${env:TOKEN}"}}}}',
  );
  const plan = await importResources({ cwd: root });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.duplicates[0]?.sources.length, 3);
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
  await assert.rejects(readdir(join(root, ".git/agent-sync")));
  assert.equal(JSON.stringify(plan).includes("${TOKEN}"), false);
  const applied = await importResources({
    cwd: root,
    apply: true,
    expect: plan.id,
  });
  assert.equal(applied.applied, true);
  const mcp = JSON.parse(await readFile(join(root, ".agent/mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.api.envFrom, { TOKEN: "TOKEN" });
});
test("same-name differing definitions need explicit selection; differently named equivalents remain separate", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".mcp.json",
    '{"mcpServers":{"api":{"command":"node"},"alias":{"command":"node"}}}',
  );
  await put(
    root,
    ".cursor/mcp.json",
    '{"mcpServers":{"api":{"command":"python"}}}',
  );
  const plan = await importResources({ cwd: root, apply: true });
  assert.equal(plan.applied, false);
  assert.equal(plan.conflicts[0]?.key, "mcp:api");
  const chosen = await importResources({
    cwd: root,
    select: { "mcp:api": "project:.mcp.json#api" },
    apply: true,
  });
  assert.equal(chosen.applied, true);
  assert.deepEqual(chosen.suggestions[0]?.names.sort(), ["alias", "api"]);
  const mcp = JSON.parse(await readFile(join(root, ".agent/mcp.json"), "utf8"));
  assert.equal(Object.keys(mcp.mcpServers).length, 2);
  assert.equal(
    JSON.parse(await readFile(join(root, ".cursor/mcp.json"), "utf8"))
      .mcpServers.api.command,
    "node",
  );
  const backup = JSON.parse(await readFile(chosen.backup!, "utf8"));
  assert.match(
    Buffer.from(backup.files[".cursor/mcp.json"].content, "base64").toString(),
    /python/,
  );
});
test("instructions deduplicate only exact files, preserve distinct fragments, and recognize the Claude adapter", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Policy\n");
  await put(root, "CLAUDE.md", "<!-- Generated -->\n@AGENTS.md\n");
  await put(root, ".cursorrules", "Additional policy\n");
  const plan = await importResources({ cwd: root, apply: true });
  assert.equal(plan.applied, true);
  assert.equal(plan.manifest.instructions.length, 2);
  assert.equal((await sync({ cwd: root })).applied, true);
  const backup = JSON.parse(await readFile(plan.backup!, "utf8"));
  assert.equal(
    Buffer.from(backup.files["AGENTS.md"].content, "base64").toString(),
    "Policy\n",
  );
  await sync({ cwd: root });
  assert.match(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    /Additional policy/,
  );
  assert.equal(
    (await importResources({ cwd: root, apply: true })).applied,
    false,
  );
});
test("identical instruction files become a single fragment without semantic merging", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Policy\n");
  await put(root, "CLAUDE.md", "Policy\n");
  await put(root, ".cursorrules", "Policy");
  const plan = await importResources({ cwd: root });
  assert.equal(plan.resources.length, 2);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0]?.sources.length, 2);
});
test("deduplicates complete skill trees including binary assets and executable modes", async (t) => {
  const root = await fixture(t);
  for (const dir of [".agents", ".claude", ".cursor"]) {
    await put(root, `${dir}/skills/review/SKILL.md`, skill);
    await put(root, `${dir}/skills/review/icon.bin`, Buffer.from([0, 255, 8]));
    await put(root, `${dir}/skills/review/run.sh`, "#!/bin/sh\n");
    await chmod(join(root, dir, "skills/review/run.sh"), 0o755);
  }
  const plan = await importResources({ cwd: root, apply: true });
  assert.equal(plan.applied, true);
  assert.equal(plan.duplicates[0]?.sources.length, 3);
  assert.deepEqual(
    await readFile(join(root, ".agent/skills/review/icon.bin")),
    Buffer.from([0, 255, 8]),
  );
  assert.equal((await sync({ cwd: root })).applied, true);
});
test("skill support-file differences cause conflicts even with identical SKILL.md", async (t) => {
  const root = await fixture(t);
  for (const dir of [".agents", ".claude"]) {
    await put(root, `${dir}/skills/review/SKILL.md`, skill);
    await put(root, `${dir}/skills/review/script.sh`, dir);
  }
  assert.equal(
    (await importResources({ cwd: root })).conflicts[0]?.key,
    "skill:review",
  );
});
test("native plugins under skill directories stay complete and are never flattened into skills", async (t) => {
  const root = await fixture(t);
  for (const dir of [".claude/skills/tools", ".cursor/plugins/local/tools"]) {
    await put(root, `${dir}/plugin.json`, plugin);
    await put(root, `${dir}/skills/review/SKILL.md`, skill);
    await put(root, `${dir}/hooks/hooks.json`, '{"hooks":{}}');
    await put(root, `${dir}/scripts/tool.bin`, Buffer.from([0, 255]));
  }
  const plan = await importResources({ cwd: root, apply: true });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.applied, true);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.resources[0]?.kind, "plugin");
  assert.equal(plan.manifest.skills.length, 0);
  assert.equal(plan.duplicates.length, 1);
  assert.deepEqual(
    await readFile(join(root, ".agent/plugins/team-tools/scripts/tool.bin")),
    Buffer.from([0, 255]),
  );
});
test("host-specific plugins retain their supported target instead of silently converting hooks", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".claude/skills/tools/.claude-plugin/plugin.json",
    '{"name":"tools"}',
  );
  await put(root, ".claude/skills/tools/hooks/hooks.json", '{"hooks":{}}');
  const plan = await importResources({ cwd: root });
  assert.deepEqual(plan.manifest.plugins[0]?.targets, ["claude"]);
  assert.deepEqual(plan.issues, []);
});
test("local plugin catalogs are resolved without duplicating the same package", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".claude-plugin/marketplace.json",
    '{"plugins":[{"name":"team-tools","source":"./packages/tools"}]}',
  );
  await put(
    root,
    ".cursor-plugin/marketplace.json",
    '{"plugins":[{"name":"team-tools","source":"./packages/tools"}]}',
  );
  await put(root, "packages/tools/plugin.json", plugin);
  const plan = await importResources({ cwd: root });
  assert.equal(plan.resources.length, 1);
  assert.deepEqual(plan.issues, []);
});
test("unsupported and mixed-purpose settings block migration before sources are created", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".codex/config.toml",
    'model="my-model"\n[mcp_servers.good]\ncommand="node"\n[mcp_servers.other]\ncommand="node"\ncwd="/custom"\n',
  );
  const initial = await importResources({ cwd: root, apply: true });
  assert.equal(initial.applied, false);
  assert.match(initial.issues[0]!.source, /#other$/);
  const selected = await importResources({
    cwd: root,
    apply: true,
    exclude: ["project:.codex/config.toml#other"],
  });
  assert.equal(selected.applied, false);
  assert.equal(
    selected.outputs.find((f) => f.path === ".codex/config.toml")?.action,
    "blocked",
  );
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
  const limited = await importResources({
    cwd: root,
    apply: true,
    exclude: ["project:.codex/config.toml#other"],
    targets: ["claude", "cursor"],
  });
  assert.equal(limited.applied, true);
  assert.match(
    await readFile(join(root, ".codex/config.toml"), "utf8"),
    /my-model/,
  );
});
test("global import is explicit, does not print literal secrets, and never changes home files", async (t) => {
  const root = await fixture(t),
    home = await fixture(t);
  await put(root, "AGENTS.md", "Project");
  await put(home, ".claude/CLAUDE.md", "Personal");
  await put(
    home,
    ".cursor/mcp.json",
    '{"mcpServers":{"api":{"command":"node","env":{"TOKEN":"do-not-print-this"}}}}',
  );
  const local = await importResources({ cwd: root });
  assert.equal(local.resources.length, 1);
  const global = await importResources({
    cwd: root,
    user: true,
    home,
    apply: true,
  });
  assert.equal(global.resources.length, 3);
  assert.equal(global.applied, true);
  assert.equal(JSON.stringify(global).includes("do-not-print-this"), false);
  assert.ok(global.warnings.some((w) => w.includes("literal")));
  assert.ok(global.outputs.every((f) => !f.path.startsWith(home)));
  await assert.rejects(importResources({ cwd: root, home }), /requires --user/);
});
test("import refuses existing manifests/source directories and rejects stale reviewed plans", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Before");
  const plan = await importResources({ cwd: root });
  await put(root, "AGENTS.md", "After");
  await assert.rejects(
    importResources({ cwd: root, apply: true, expect: plan.id }),
    /changed since review/,
  );
  await put(root, ".agent/owned.md", "Mine");
  const blocked = await importResources({ cwd: root, apply: true });
  assert.equal(blocked.applied, false);
  assert.match(blocked.issues[0]!.message, /left untouched/);
});
test("local output import refuses tracked destinations before creating sources", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Policy");
  git(root, "add", "AGENTS.md");
  const tracked = await importResources({
    cwd: root,
    apply: true,
    outputs: "local",
  });
  assert.equal(tracked.applied, false);
  assert.match(tracked.outputs[0]!.reason!, /tracked/);
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Policy");
  git(root, "rm", "--cached", "AGENTS.md");
  assert.equal(
    (await importResources({ cwd: root, apply: true, outputs: "local" }))
      .applied,
    true,
  );
});
test("shared sources can be edited and synced immediately after import", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Policy");
  const plan = await importResources({ cwd: root, apply: true });
  await put(root, plan.manifest.instructions[0]!.path, "Changed");
  assert.equal((await sync({ cwd: root })).applied, true);
  assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /Changed/);
  await put(root, "AGENTS.md", "Local edit");
  assert.equal((await sync({ cwd: root })).applied, false);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Local edit");
});
test("unsafe or unsupported inputs block import while scoped Cursor rules are retained", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await put(outside, "private.md", "Private");
  await symlink(join(outside, "private.md"), join(root, "AGENTS.md"));
  await put(root, ".cursor/rules/scoped.mdc", "---\nglobs: *.ts\n---\nRules");
  await put(root, "CLAUDE.md", "@other.md\n");
  const plan = await importResources({
    cwd: root,
    apply: true,
    select: { "mcp:typo": "project:missing" },
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.issues.length, 3);
  assert.ok(plan.retained.includes("project:.cursor/rules/scoped.mdc"));
  assert.equal(JSON.stringify(plan).includes("Private"), false);
});
test("import CLI previews, completes migration and syncs from the compiled package", async (t) => {
  const root = await fixture(t);
  await put(root, "AGENTS.md", "Policy\n");
  const cli = resolve("dist/cli.js");
  const call = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--cwd", root], {
      encoding: "utf8",
    });
  const preview = call("import", "--dry-run", "--json");
  assert.equal(preview.status, 0);
  const plan = JSON.parse(preview.stdout);
  const applied = call("import", "--yes", "--json", "--expect", plan.id);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  assert.equal(call("adopt").status, 1);
  assert.doesNotMatch(call("--help").stdout, /adopt|PLAN_ID|--apply/);
  assert.equal(call("sync").status, 0);
  assert.equal(
    parseManifest(await readFile(join(root, ".agent-sync.yaml"), "utf8"))
      .instructions.length,
    1,
  );
});

test("missing catalog packages and malformed header mappings block import explicitly", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".claude-plugin/marketplace.json",
    '{"plugins":[{"name":"missing","source":"./packages/missing"}]}',
  );
  await put(
    root,
    ".codex/config.toml",
    '[mcp_servers.api]\nurl="https://example.com/mcp"\nenv_http_headers="TOKEN"\n',
  );
  const plan = await importResources({ cwd: root, apply: true });
  assert.equal(plan.applied, false);
  assert.equal(plan.issues.length, 2);
});
test("import reports retained legacy files rather than silently managing or removing them", async (t) => {
  const root = await fixture(t);
  await put(root, ".codex/skills/review/SKILL.md", skill);
  const plan = await importResources({ cwd: root, apply: true });
  assert.equal(plan.applied, true);
  assert.ok(plan.retained.includes(".codex/skills/review/SKILL.md"));
  await sync({ cwd: root });
  assert.equal(
    await readFile(join(root, ".codex/skills/review/SKILL.md"), "utf8"),
    skill,
  );
});
