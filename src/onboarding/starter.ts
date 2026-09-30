import { mkdir, open, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { git, type Repository } from "../git/repository.js";
import { MANIFEST_FILE, type Manifest } from "../manifest/manifest.js";
import {
  SourceResolver,
  confinedPath,
  exists,
  type FileTree,
} from "../sources/source.js";
import { writeSnapshot } from "../sync/state.js";

const instructionPath = ".agent/instructions.md";
const instructions =
  "# Repository instructions\n\nDescribe this repository and its development workflow.\n";
function starterFiles(outputs?: Manifest["outputs"]): FileTree {
  return new Map([
    [
      MANIFEST_FILE,
      {
        content: Buffer.from(
          `version: 1\ntargets: [codex, claude, cursor]\n${outputs ? `outputs: ${outputs}\n` : ""}instructions:\n  - path: ${instructionPath}\n`,
        ),
        executable: false,
      },
    ],
    [
      instructionPath,
      { content: Buffer.from(instructions), executable: false },
    ],
  ]);
}

/** Recognize only our exact, unedited starter, including the earlier CLI's template. */
export async function inspectStarter(
  repo: Repository,
): Promise<FileTree | undefined> {
  if (await exists(join(repo.stateDir, "active.json"))) return;
  const tracked = await git(repo.root, [
    "ls-files",
    "--",
    MANIFEST_FILE,
    ".agent",
  ]);
  if (tracked) return;
  try {
    const source = await new SourceResolver(repo, true).resolve({});
    const tree = await source.tree(".agent");
    if (
      tree.size !== 1 ||
      tree.get("instructions.md")?.content.toString() !== instructions
    )
      return;
    const manifest = await source.file(MANIFEST_FILE);
    if (
      ![undefined, "local", "committed"].some((mode) =>
        starterFiles(mode as Manifest["outputs"] | undefined)
          .get(MANIFEST_FILE)
          ?.content.equals(manifest.content),
      )
    )
      return;
    return new Map([
      [MANIFEST_FILE, manifest],
      [instructionPath, tree.get("instructions.md")!],
    ]);
  } catch {
    return;
  }
}

export async function createStarter(
  repo: Repository,
  outputs: Manifest["outputs"] = "committed",
) {
  const files = starterFiles(outputs);
  const created: string[] = [];
  await mkdir(await confinedPath(repo.root, ".agent"));
  try {
    for (const [path, file] of files) {
      const handle = await open(
        await confinedPath(repo.root, path),
        "wx",
        0o600,
      );
      try {
        await handle.writeFile(file.content);
        created.push(path);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    for (const path of created) await rm(join(repo.root, path));
    await rmdir(join(repo.root, ".agent"));
    throw error;
  }
}

export async function archiveStarter(
  repo: Repository,
  files: FileTree,
  id: string,
) {
  const fresh = await inspectStarter(repo);
  if (
    !fresh ||
    [...files].some(
      ([path, file]) => !fresh.get(path)?.content.equals(file.content),
    )
  )
    throw new Error(
      "Starter files changed during review; run init again. Nothing was replaced.",
    );
  await writeSnapshot(repo.stateDir, `backups/starter-${id}.json`, {
    content: Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          [...files].map(([path, file]) => [
            path,
            {
              content: file.content.toString("base64"),
              executable: file.executable,
            },
          ]),
        ),
      ),
    ).toString("base64"),
    executable: false,
  });
  for (const path of files.keys())
    await rm(await confinedPath(repo.root, path));
  await rmdir(await confinedPath(repo.root, ".agent"));
}

export async function restoreStarter(repo: Repository, files: FileTree) {
  await mkdir(await confinedPath(repo.root, ".agent"), { recursive: true });
  for (const [path, file] of files) {
    const handle = await open(
      await confinedPath(repo.root, path),
      "wx",
      file.executable ? 0o700 : 0o600,
    );
    try {
      await handle.writeFile(file.content);
    } finally {
      await handle.close();
    }
  }
}
