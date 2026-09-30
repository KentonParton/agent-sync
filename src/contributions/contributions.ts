import { restoreSkillContribution } from "../skills/skills.js";
import { restoreMcpSource } from "../mcp/promotion.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { git, repository } from "../git/repository.js";
import {
  confinedPath,
  exists,
  SourceResolver,
  type Provenance,
} from "../sources/source.js";
import {
  localChanges,
  readState,
  snapshot,
  withLock,
  writeSnapshot,
  equal,
  saveState,
  type Baseline,
} from "../sync/state.js";
const exec = promisify(execFile);
export async function diff(cwd = process.cwd()) {
  const repo = await repository(cwd);
  return localChanges(repo);
}
export async function merge(path: string, cwd = process.cwd()) {
  const repo = await repository(cwd);
  return withLock(repo, async () => {
    const state = await readState(repo);
    const baseline = state.files[path];
    if (!baseline) throw new Error(`Not a managed output: ${path}`);
    const candidatePath = join(repo.stateDir, "candidate.json");
    if (!(await exists(candidatePath)))
      throw new Error("Run sync first to resolve the new upstream candidate");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
      head: string;
      files: Record<string, Baseline>;
    };
    if (candidate.head !== repo.head)
      throw new Error("The checkout changed; run sync again before merging");
    const next = candidate.files[path];
    const current = await snapshot(repo.root, path);
    if (!current || !next)
      throw new Error(
        "Deletion conflicts require explicit replace or a source edit",
      );
    for (const value of [baseline, current, next])
      if (Buffer.from(value.content, "base64").includes(0))
        throw new Error(
          "Binary changes require explicit replace or a source edit",
        );
    const folder = join(repo.stateDir, "merges", randomUUID());
    await mkdir(folder, { recursive: true });
    const inputs = [current, baseline, next];
    for (let i = 0; i < inputs.length; i++)
      await writeFile(
        join(folder, String(i)),
        Buffer.from(inputs[i]!.content, "base64"),
      );
    let content: string;
    let conflicted = false;
    try {
      content = (
        await exec(
          "git",
          [
            "merge-file",
            "-p",
            "-L",
            "local",
            "-L",
            "baseline",
            "-L",
            "upstream",
            ...inputs.map((_, i) => join(folder, String(i))),
          ],
          { maxBuffer: 32 * 1024 * 1024 },
        )
      ).stdout;
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      if (
        typeof failure.code !== "number" ||
        failure.code < 1 ||
        failure.code > 127
      )
        throw error;
      content = failure.stdout;
      conflicted = true;
    }
    const resultPath = join(folder, "result");
    await writeFile(resultPath, content, { mode: 0o600 });
    if (conflicted) return { path, conflicted, resultPath };
    if (!equal(current, await snapshot(repo.root, path)))
      throw new Error(
        "Output changed during merge; merge result preserved separately",
      );
    await writeSnapshot(repo.root, path, {
      content: Buffer.from(content).toString("base64"),
      executable: current.executable,
    });
    state.files[path] = next;
    await saveState(repo, state);
    return { path, conflicted, resultPath };
  });
}
export interface PromoteOptions {
  cwd?: string;
  sourceIndex?: number;
  branch?: string;
  publish?: boolean;
  title?: string;
  body?: string;
}
export async function promote(path: string, options: PromoteOptions = {}) {
  const repo = await repository(options.cwd ?? process.cwd());
  return withLock(repo, async () => {
    const state = await readState(repo);
    const baseline = state.files[path];
    const current = await snapshot(repo.root, path);
    if (!baseline || !current)
      throw new Error(
        "Promotion requires an existing managed output; deletions must be edited in the source",
      );
    if (equal(current, baseline))
      throw new Error(`No local change to promote: ${path}`);
    const selected = selectContribution(
      path,
      baseline,
      current.content,
      options.sourceIndex,
    );
    const provenance = selected.provenance;
    const source = await new SourceResolver(repo, true).resolve({
      source: provenance.source === "local" ? undefined : provenance.source,
      ref: provenance.ref,
    });
    const original = await source.file(provenance.path);
    if (
      baseline.kind === "mcp" &&
      JSON.parse(original.content.toString("utf8")).$schema
    ) {
      throw new Error(
        "Promote plugin MCP changes from the preserved .agent-sync/plugins package; projected MCP names and substitutions are host-specific",
      );
    }
    let content = selected.content;
    const projectedSkill =
      baseline.kind === "skill" && posix.basename(path) === "SKILL.md";
    if (projectedSkill)
      content = restoreSkillContribution(
        original.content,
        Buffer.from(baseline.content, "base64"),
        content,
        posix.basename(posix.dirname(path)),
      );
    if (provenance.source === "local") {
      // Never rewrite repository-owned source automatically. Produce a reviewable patch in a separate worktree.
      if (repo.head === "unborn")
        throw new Error(
          "Commit the repository before preparing a contribution branch",
        );
    }
    if (
      (baseline.kind === "skill" && !projectedSkill) ||
      baseline.kind === "plugin"
    ) {
      if (!original.content.equals(Buffer.from(baseline.content, "base64")))
        throw new Error(
          "Source differs from the generated baseline; sync or merge first",
        );
    }
    const folder = join(repo.stateDir, "contributions", randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const checkout = join(folder, "checkout");
    const origin =
      provenance.source === "local"
        ? repo.root
        : provenance.source.startsWith(".")
          ? join(repo.root, provenance.source)
          : provenance.source;
    const revision = provenance.revision ?? repo.head;
    await git(folder, [
      "clone",
      "--no-checkout",
      "--no-hardlinks",
      "--",
      origin,
      checkout,
    ]);
    const branch =
      options.branch ?? `codex/agent-sync-${randomUUID().slice(0, 8)}`;
    await git(checkout, ["check-ref-format", "--branch", branch]);
    const existingBranches = (
      await git(checkout, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin",
      ])
    ).split("\n");
    if (existingBranches.includes(`refs/remotes/origin/${branch}`))
      throw new Error(
        "Promotion requires a new branch; this remote branch already exists",
      );
    if (branch === "main" || branch === "master" || branch === provenance.ref)
      throw new Error("Promotion must use a new review branch");
    await git(checkout, [
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "-b",
      branch,
      revision,
    ]);
    const destination = await confinedPath(checkout, provenance.path);
    // Comparing against the selected revision prevents routing stale edits to a different file version.
    if (!(await readFile(destination)).equals(original.content))
      throw new Error(
        "Source revision changed; sync and resolve the source first",
      );
    await writeFile(destination, content);
    await git(checkout, ["add", "--", provenance.path]);
    const patch = await git(checkout, ["diff", "--cached", "--binary"]);
    if (!patch) throw new Error("Selected source has no changes to promote");
    const patchPath = join(folder, "change.patch");
    await writeFile(patchPath, patch + "\n", { mode: 0o600 });
    let pullRequest: string | undefined;
    if (options.publish) {
      if (provenance.source === "local")
        throw new Error(
          "For local sources, review the contribution checkout and publish against the application repository explicitly",
        );
      const title =
        options.title ??
        `Update ${posix.basename(provenance.path)} from agent-sync`;
      await git(checkout, [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        title,
      ]);
      await git(checkout, [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        `--force-with-lease=refs/heads/${branch}:`,
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
      const bodyPath = join(folder, "body.md");
      await writeFile(
        bodyPath,
        options.body ??
          `Promotes a local improvement from an agent-sync managed output to its owning source.\n\nSource: ${provenance.path}\nBaseline: ${revision}\n`,
      );
      const args = [
        "pr",
        "create",
        "--draft",
        "--title",
        title,
        "--body-file",
        bodyPath,
        "--head",
        branch,
      ];
      if (
        provenance.ref &&
        provenance.ref !== "HEAD" &&
        !/^[a-f0-9]{40}$/.test(provenance.ref)
      )
        args.push("--base", provenance.ref);
      pullRequest = (
        await exec("gh", args, { cwd: checkout, timeout: 60_000 })
      ).stdout.trim();
    }
    return { checkout, branch, patchPath, provenance, pullRequest };
  });
}
function selectContribution(
  path: string,
  baseline: Baseline,
  edited: string,
  sourceIndex?: number,
): { provenance: Provenance; content: Buffer } {
  if (baseline.kind === "mcp") {
    const sources = [
      ...new Map(
        baseline.provenance.map((p) => [JSON.stringify(p), p]),
      ).values(),
    ];
    if (sources.length !== 1)
      throw new Error(
        "MCP output combines multiple sources; edit those sources directly to avoid ambiguous routing",
      );
    return {
      provenance: sources[0]!,
      content: restoreMcpSource(path, Buffer.from(edited, "base64")),
    };
  }
  if (path === "CLAUDE.md")
    throw new Error(
      "CLAUDE.md is an import adapter; promote edits to AGENTS.md instead",
    );
  if (path === "AGENTS.md") {
    const split = (data: string) =>
      Buffer.from(data, "base64")
        .toString("utf8")
        .trim()
        .split(/\n\n<!-- agent-sync -->\n\n/);
    const before = split(baseline.content),
      after = split(edited);
    if (
      before.length !== baseline.provenance.length ||
      after.length !== before.length
    )
      throw new Error(
        "Instruction section boundaries changed; edit a source directly",
      );
    const changed = after.flatMap((section, i) =>
      section === before[i] ? [] : [i],
    );
    const index =
      sourceIndex ?? (changed.length === 1 ? changed[0] : undefined);
    if (index === undefined || !changed.includes(index))
      throw new Error(
        `Choose --source-index from changed instruction sections: ${changed.join(", ")}`,
      );
    return {
      provenance: baseline.provenance[index]!,
      content: Buffer.from(after[index] + "\n"),
    };
  }
  if (baseline.provenance.length !== 1)
    throw new Error("Ambiguous provenance; edit the declared source directly");
  return {
    provenance: baseline.provenance[0]!,
    content: Buffer.from(edited, "base64"),
  };
}
