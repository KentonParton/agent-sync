import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { git, type Repository } from "../git/repository.js";
import { relativePathSchema, type SourceSpec } from "../manifest/manifest.js";

export interface SourceFile {
  content: Buffer;
  executable: boolean;
}
export type FileTree = Map<string, SourceFile>;
export interface Provenance {
  source: string;
  ref?: string;
  revision?: string;
  path: string;
}
export interface ResolvedSource {
  provenance(path: string): Provenance;
  file(path: string): Promise<SourceFile>;
  tree(path: string): Promise<FileTree>;
}
export function fingerprint(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
// Used on both source and destination paths: never follow a symlink supplied by a repository.
export async function confinedPath(
  root: string,
  path: string,
): Promise<string> {
  relativePathSchema.parse(path);
  let current = root;
  for (const part of path.split("/").filter((p) => p && p !== ".")) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing symlink: ${current}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return current;
}
function localSource(root: string): ResolvedSource {
  const file = async (path: string): Promise<SourceFile> => {
    const full = await confinedPath(root, path);
    const stat = await lstat(full);
    if (!stat.isFile()) throw new Error(`Expected regular file: ${full}`);
    return { content: await readFile(full), executable: !!(stat.mode & 0o111) };
  };
  return {
    provenance: (path) => ({ source: "local", path }),
    file,
    async tree(path) {
      const tree: FileTree = new Map();
      async function visit(relative: string) {
        const full = await confinedPath(root, posix.join(path, relative));
        const stat = await lstat(full);
        if (stat.isDirectory()) {
          for (const name of (await readdir(full)).sort()) {
            if (name === ".git")
              throw new Error(
                `Nested Git metadata is not a syncable resource: ${full}`,
              );
            await visit(posix.join(relative, name));
          }
        } else tree.set(relative, await file(posix.join(path, relative)));
      }
      await visit("");
      return tree;
    },
  };
}
export class SourceResolver {
  private sources = new Map<string, Promise<ResolvedSource>>();
  readonly warnings: string[] = [];
  constructor(
    private repo: Repository,
    private offline = false,
  ) {}
  resolve(spec: Pick<SourceSpec, "source" | "ref">): Promise<ResolvedSource> {
    if (!spec.source) return Promise.resolve(localSource(this.repo.root));
    const key = JSON.stringify([spec.source, spec.ref ?? "HEAD"]);
    let pending = this.sources.get(key);
    if (!pending) {
      pending = this.remote(spec.source, spec.ref ?? "HEAD", key);
      this.sources.set(key, pending);
    }
    return pending;
  }
  private async remote(
    source: string,
    ref: string,
    key: string,
  ): Promise<ResolvedSource> {
    const cache = join(this.repo.stateDir, "sources", fingerprint(key));
    const checkout = join(cache, "repo.git");
    const verified = join(cache, "verified.json");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    if (!(await exists(checkout)))
      await git(cache, ["init", "--bare", checkout]);
    let revision: string | undefined;
    if (!this.offline) {
      try {
        const url = source.startsWith(".")
          ? resolve(this.repo.root, source)
          : source;
        await git(checkout, ["fetch", "--no-tags", "--force", "--", url, ref]);
        revision = await git(checkout, [
          "rev-parse",
          "--verify",
          "FETCH_HEAD^{commit}",
        ]);
        await git(checkout, [
          "update-ref",
          "refs/agent-sync/verified",
          revision,
        ]);
        await writeFile(verified, JSON.stringify({ revision }), {
          mode: 0o600,
        });
      } catch (error) {
        if (!(await exists(verified)))
          throw new Error(`Cannot resolve ${source} at ${ref}`, {
            cause: error,
          });
        this.warnings.push(
          `Fetch unavailable; using cached ${source} at ${ref}.`,
        );
      }
    }
    if (!revision) {
      if (!(await exists(verified)))
        throw new Error(`No verified offline cache for ${source} at ${ref}`);
      revision = JSON.parse(await readFile(verified, "utf8"))
        .revision as string;
      await git(checkout, ["cat-file", "-e", `${revision}^{commit}`]);
    }
    const commit = revision;
    const entries = new Map<string, { mode: string; oid: string }>();
    const listing = await git(checkout, ["ls-tree", "-rz", commit]);
    for (const entry of listing.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t");
      const [mode, type, oid] = metadata!.split(" ");
      if (path && oid)
        entries.set(path, {
          mode: type === "blob" ? mode! : "unsupported",
          oid,
        });
    }
    const file = async (path: string): Promise<SourceFile> => {
      path = posix.normalize(relativePathSchema.parse(path));
      const entry = entries.get(path);
      if (!entry)
        throw new Error(`Missing source file ${source}:${path} at ${ref}`);
      if (!["100644", "100755"].includes(entry.mode))
        throw new Error(`Symlinks and submodules are not supported: ${path}`);
      // cat-file must retain arbitrary binary bytes, including trailing newlines.
      const { execFile } = await import("node:child_process");
      const content = await new Promise<Buffer>((resolve, reject) =>
        execFile(
          "git",
          ["cat-file", "blob", entry.oid],
          {
            cwd: checkout,
            encoding: "buffer",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30_000,
          },
          (error, out) => (error ? reject(error) : resolve(out)),
        ),
      );
      return { content, executable: entry.mode === "100755" };
    };
    return {
      provenance: (path) => ({ source, ref, revision: commit, path }),
      file,
      async tree(path) {
        const prefix = posix
          .normalize(relativePathSchema.parse(path))
          .replace(/\/$/, "");
        const tree: FileTree = new Map();
        for (const name of [...entries.keys()].sort()) {
          if (prefix === "." || name.startsWith(`${prefix}/`))
            tree.set(
              prefix === "." ? name : name.slice(prefix.length + 1),
              await file(name),
            );
        }
        if (!tree.size)
          throw new Error(
            `Missing or empty source directory ${source}:${path}`,
          );
        return tree;
      },
    };
  }
}
