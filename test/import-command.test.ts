import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runImportCommand,
  type ImportInteraction,
} from "../src/import/command.js";
import { sync } from "../src/index.js";

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agent-sync-guided-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  await writeFile(join(root, "AGENTS.md"), "Original instructions\n");
  return root;
}
function interaction(answers: (string | undefined)[], interactive = true) {
  const messages: string[] = [],
    questions: string[] = [];
  const io: ImportInteraction = {
    interactive,
    write: (message) => messages.push(message),
    ask: async (question) => {
      questions.push(question);
      return answers.shift();
    },
  };
  return { io, messages, questions };
}
async function untouched(root: string) {
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Original instructions\n",
  );
  await assert.rejects(readdir(join(root, ".agent")));
  await assert.rejects(readFile(join(root, ".agent-sync.yaml")));
}

test("guided import confirms once and immediately prepares working tool files", async (t) => {
  const root = await fixture(t);
  const { io, messages, questions } = interaction(["yes"]);
  assert.equal(await runImportCommand({ cwd: root }, io), 0);
  assert.equal(questions.length, 1);
  assert.match(questions[0]!, /Back up/);
  assert.doesNotMatch(questions.join("\n"), /PLAN_ID|expect|adopt/);
  assert.match(messages.join("\n"), /Import complete/);
  assert.match(await readFile(join(root, "CLAUDE.md"), "utf8"), /@AGENTS.md/);
  const result = await sync({ cwd: root });
  assert.equal(result.applied, true);
  assert.ok(result.changes.every((change) => change.action === "unchanged"));
});
for (const answer of ["n", "", undefined]) {
  test(`declining or cancelling import (${String(answer)}) writes nothing`, async (t) => {
    const root = await fixture(t);
    const { io, messages } = interaction([answer]);
    assert.equal(await runImportCommand({ cwd: root }, io), 0);
    await untouched(root);
    await assert.rejects(readdir(join(root, ".git/agent-sync")));
    assert.match(messages.join("\n"), /cancelled/);
  });
}

test("guided conflicts accept a numbered source and preserve displaced originals in backups", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".cursor"));
  await writeFile(
    join(root, ".mcp.json"),
    '{"mcpServers":{"api":{"command":"node"}}}',
  );
  const cursor = '{"mcpServers":{"api":{"command":"python"}}}';
  await writeFile(join(root, ".cursor/mcp.json"), cursor);
  const { io, messages, questions } = interaction(["invalid", "1", "y"]);
  assert.equal(await runImportCommand({ cwd: root }, io), 0);
  assert.equal(questions.length, 3);
  assert.match(messages.join("\n"), /Enter one of the listed numbers/);
  const chosen = JSON.parse(
    await readFile(join(root, ".agent/mcp.json"), "utf8"),
  );
  const generated = JSON.parse(
    await readFile(join(root, ".cursor/mcp.json"), "utf8"),
  );
  assert.equal(generated.mcpServers.api.command, chosen.mcpServers.api.command);
  const backups = join(root, ".git/agent-sync/backups");
  const backup = JSON.parse(
    await readFile(join(backups, (await readdir(backups))[0]!), "utf8"),
  );
  assert.equal(
    Buffer.from(backup.files[".cursor/mcp.json"].content, "base64").toString(),
    cursor,
  );
});

test("conflict cancellation and unattended conflicts never create sources", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".cursor"));
  await writeFile(
    join(root, ".mcp.json"),
    '{"mcpServers":{"api":{"command":"node"}}}',
  );
  await writeFile(
    join(root, ".cursor/mcp.json"),
    '{"mcpServers":{"api":{"command":"python"}}}',
  );
  assert.equal(await runImportCommand({ cwd: root }, interaction(["q"]).io), 0);
  await untouched(root);
  const unattended = interaction([], false);
  assert.equal(
    await runImportCommand({ cwd: root, yes: true }, unattended.io),
    2,
  );
  assert.equal(unattended.questions.length, 0);
  await untouched(root);
});

test("a source edited while confirmation is pending invalidates the reviewed migration", async (t) => {
  const root = await fixture(t);
  const { io } = interaction([]);
  io.ask = async () => {
    await writeFile(join(root, "AGENTS.md"), "Concurrent edit");
    return "yes";
  };
  await assert.rejects(
    runImportCommand({ cwd: root }, io),
    /changed since review/,
  );
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Concurrent edit",
  );
  await assert.rejects(readdir(join(root, ".agent")));
});

for (const mode of ["nonterminal", "dry-run", "json"] as const) {
  test(`${mode} defaults to a read-only preview with no prompts`, async (t) => {
    const root = await fixture(t);
    const { io, questions, messages } = interaction([], mode !== "nonterminal");
    assert.equal(
      await runImportCommand(
        { cwd: root, dryRun: mode === "dry-run", json: mode === "json" },
        io,
      ),
      0,
    );
    assert.equal(questions.length, 0);
    if (mode === "json")
      assert.equal(JSON.parse(messages.join("\n")).applied, false);
    await untouched(root);
    await assert.rejects(readdir(join(root, ".git/agent-sync")));
  });
}

test("unattended JSON import returns exactly one applied result", async (t) => {
  const root = await fixture(t);
  const { io, questions, messages } = interaction([], false);
  assert.equal(
    await runImportCommand({ cwd: root, yes: true, json: true }, io),
    0,
  );
  assert.equal(questions.length, 0);
  const result = JSON.parse(messages.join("\n"));
  assert.equal(result.applied, true);
  assert.ok(result.backup);
  assert.equal((await sync({ cwd: root })).applied, true);
});

test("local output mode blocks tracked destinations before confirmation", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["add", "AGENTS.md"], { cwd: root });
  const { io, questions, messages } = interaction(["yes"]);
  assert.equal(await runImportCommand({ cwd: root, outputs: "local" }, io), 2);
  assert.equal(questions.length, 0);
  assert.match(messages.join("\n"), /tracked by Git/);
  await untouched(root);
});
