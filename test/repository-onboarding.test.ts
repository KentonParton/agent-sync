/**
 * Optional acceptance test against a caller-supplied local repository.
 * Uses real Git and filesystem state in disposable clones; no database is involved.
 * External boundaries mocked: none. Host apps and network services are not invoked.
 * Covers discovery, partial setup recovery, file preservation, teammate clones,
 * checkout automation, hook-manager reset, worktrees, and local-edit protection.
 * The default onboarding reproductions run separately without this external checkout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  cp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  importResources,
  sync,
  installHooks,
  parseManifest,
} from "../src/index.js";

// Run explicitly against a local repository; all mutations happen in disposable clones.
test(
  "real repository: recover onboarding, clone, checkout, worktree, hooks and local edits",
  { skip: !process.env.AGENT_SYNC_TEST_REPO },
  async (t) => {
    const source = await realpath(process.env.AGENT_SYNC_TEST_REPO!);
    const base = await realpath(
      await mkdtemp(join(tmpdir(), "agent-sync-real-repo-")),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
    const git = (root: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const sourceStatus = git(source, "status", "--porcelain=v1");
    const root = join(base, "onboarding"),
      clone = join(base, "teammate");
    git(
      base,
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--shared",
      "--quiet",
      source,
      root,
    );
    git(root, "config", "user.name", "Agent Sync Verification");
    git(root, "config", "user.email", "agent-sync@example.invalid");
    // Reproduce the user-visible partial init, without copying private operational state.
    for (const path of [".agent-sync.yaml", ".agent"]) {
      try {
        await cp(join(source, path), join(root, path), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const originalPaths = git(
      root,
      "ls-files",
      "AGENTS.md",
      "CLAUDE.md",
      ".cursor/rules",
      ".cursor/commands",
      ".cursor/skills",
    )
      .split("\n")
      .filter(Boolean);
    const originals = new Map(
      await Promise.all(
        originalPaths.map(
          async (path) => [path, await readFile(join(root, path))] as const,
        ),
      ),
    );
    const preview = await importResources({ cwd: root });
    assert.deepEqual(preview.issues, []);
    assert.deepEqual(preview.conflicts, []);
    const cli = resolve("dist/cli.js");
    const applied = spawnSync(
      process.execPath,
      [cli, "init", "--yes", "--json", "--cwd", root],
      { encoding: "utf8" },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const migration = JSON.parse(applied.stdout);
    assert.equal(migration.applied, true);
    for (const [path, bytes] of originals)
      assert.deepEqual(
        await readFile(join(root, path)),
        bytes,
        `${path} changed`,
      );
    assert.ok(
      (await sync({ cwd: root })).changes.every(
        (c) => c.action === "unchanged",
      ),
    );
    git(
      root,
      "add",
      "-f",
      "--",
      ...preview.files,
      ...preview.outputs.map((o) => o.path),
    );
    git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Verify Agent Sync migration in disposable clone",
    );
    assert.equal(git(root, "status", "--porcelain"), "");
    git(
      base,
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--quiet",
      root,
      clone,
    );
    const teammate = spawnSync(
      process.execPath,
      [cli, "init", "--yes", "--json", "--cwd", clone],
      { encoding: "utf8" },
    );
    assert.equal(teammate.status, 0, teammate.stderr);
    assert.equal(JSON.parse(teammate.stdout).applied, true);
    assert.equal(git(clone, "status", "--porcelain"), "");
    const originalBranch = git(root, "branch", "--show-current");
    git(root, "checkout", "-b", "codex/verify-onboarding");
    const manifest = parseManifest(
      await readFile(join(root, ".agent-sync.yaml"), "utf8"),
    );
    const instruction = manifest.instructions[0]!.path;
    await writeFile(
      join(root, instruction),
      `${await readFile(join(root, instruction), "utf8")}\nVerification branch instruction.\n`,
    );
    assert.equal((await sync({ cwd: root })).applied, true);
    git(root, "add", "--", instruction, "AGENTS.md");
    git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Verify branch-specific instructions",
    );
    git(root, "config", "core.hooksPath", "./scripts/git-hooks");
    const installed = await installHooks(root, cli);
    assert.match(
      await readFile(join(installed.hooks, "pre-commit"), "utf8"),
      /scripts\/git-hooks\/pre-commit/,
    );
    git(root, "config", "core.hooksPath", "./scripts/git-hooks");
    assert.equal((await installHooks(root, cli)).installed, true);
    git(root, "checkout", originalBranch);
    assert.deepEqual(
      await readFile(join(root, "AGENTS.md")),
      originals.get("AGENTS.md"),
    );
    git(root, "checkout", "codex/verify-onboarding");
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /Verification branch instruction/,
    );
    assert.equal(git(root, "status", "--porcelain"), "");
    const worktree = join(base, "worktree");
    git(root, "worktree", "add", "--detach", worktree, originalBranch);
    assert.equal((await sync({ cwd: worktree })).applied, true);
    assert.equal(git(worktree, "status", "--porcelain"), "");
    await writeFile(join(clone, "AGENTS.md"), "Developer's local edit\n");
    assert.equal((await sync({ cwd: clone })).applied, false);
    assert.equal(
      await readFile(join(clone, "AGENTS.md"), "utf8"),
      "Developer's local edit\n",
    );
    assert.equal(git(source, "status", "--porcelain=v1"), sourceStatus);
    t.diagnostic(
      JSON.stringify({
        resources: preview.resources.length,
        outputs: preview.outputs.length,
        retained: preview.retained.length,
        originalsPreserved: originals.size,
        recoveringStarter: preview.recoveringStarter,
      }),
    );
  },
);
