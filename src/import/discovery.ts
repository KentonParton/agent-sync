import { readdir } from "node:fs/promises";
import { posix } from "node:path";
import TOML from "@iarna/toml";
import { type Harness } from "../manifest/manifest.js";
import { restoreMcpSource } from "../mcp/promotion.js";
import { mcpLocations, type McpServer } from "../mcp/mcp.js";
import {
  inspectPlugin,
  pluginManifestPaths,
  pluginPaths,
} from "../plugins/plugins.js";
import { skillLocations, installSkill } from "../skills/skills.js";
import { OutputPlan } from "../sync/plan.js";
import {
  confinedPath,
  exists,
  fingerprint,
  SourceResolver,
  type FileTree,
  type SourceFile,
} from "../sources/source.js";

export type ImportKind = "instructions" | "skill" | "plugin" | "mcp";
export interface ImportResource {
  id: string;
  kind: ImportKind;
  name: string;
  scope: "project" | "user";
  path: string;
  files: FileTree;
  digest: string;
  targets?: Harness[];
  server?: McpServer;
}
export interface ImportIssue {
  source: string;
  message: string;
}
export interface ObservedFile {
  root: string;
  path: string;
  digest: string;
  executable: boolean;
  adoptable: boolean;
}
export interface Discovery {
  resources: ImportResource[];
  issues: ImportIssue[];
  warnings: string[];
  observed: ObservedFile[];
  excluded: string[];
  retained: string[];
}
export function fileDigest(file: SourceFile): string {
  return fingerprint(
    Buffer.concat([
      Buffer.from(file.executable ? "executable\0" : "file\0"),
      file.content,
    ]),
  );
}
export function treeDigest(tree: FileTree): string {
  return fingerprint(
    JSON.stringify(
      [...tree]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, f]) => [p, fileDigest(f)]),
    ),
  );
}
// Object key order is irrelevant to MCP identity; array order (especially arguments) is significant.
export function canonicalMcp(server: McpServer): string {
  const order = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(order)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, order(v)]),
          )
        : value;
  return JSON.stringify(order(server));
}
export async function discover(
  root: string,
  scope: ImportResource["scope"],
  exclude: Set<string>,
): Promise<Discovery> {
  const result: Discovery = {
    resources: [],
    issues: [],
    warnings: [],
    observed: [],
    excluded: [],
    retained: [],
  };
  const source = await new SourceResolver(
    { root, stateDir: "", head: "" },
    true,
  ).resolve({});
  const id = (path: string) => `${scope}:${path}`;
  const omitted = (path: string) => {
    const key = id(path);
    if (!exclude.has(key)) return false;
    result.excluded.push(key);
    return true;
  };
  const present = async (path: string) =>
    exists(await confinedPath(root, path));
  const observe = (path: string, file: SourceFile, adoptable = true) =>
    result.observed.push({
      root,
      path,
      digest: fileDigest(file),
      executable: file.executable,
      adoptable: scope === "project" && adoptable,
    });
  const observeTree = (path: string, tree: FileTree) => {
    for (const [name, file] of tree) observe(posix.join(path, name), file);
  };
  const visit = async (
    path: string,
    action: () => Promise<void>,
    required = false,
  ) => {
    if (omitted(path)) return;
    try {
      if (await present(path)) await action();
      else if (required) throw new Error("Missing declared resource");
    } catch {
      result.issues.push({
        source: id(path),
        message:
          "Cannot safely read or normalize this resource. Check its format, unsupported settings, and symlinks; no content was printed.",
      });
    }
  };
  const instructions =
    scope === "project"
      ? ["AGENTS.md", "CLAUDE.md", ".cursorrules"]
      : [".codex/AGENTS.md", ".claude/CLAUDE.md", ".cursorrules"];
  for (const path of instructions)
    await visit(path, async () => {
      const file = await source.file(path);
      observe(path, file);
      const text = file.content.toString("utf8");
      if (
        scope === "project" &&
        path === "CLAUDE.md" &&
        text.replace(/<!--[\s\S]*?-->/g, "").trim() === "@AGENTS.md" &&
        (await present("AGENTS.md"))
      )
        return;
      if (/^\s*@\S+\.md\s*$/m.test(text))
        throw new Error("Instruction imports need explicit migration");
      result.resources.push({
        id: id(path),
        kind: "instructions",
        scope,
        path,
        name: posix.basename(path, ".md").toLowerCase().replace(/^\./, ""),
        files: new Map([["", file]]),
        digest: fingerprint(file.content),
      });
    });
  const agents = result.resources.find(
    (r) => r.path === "AGENTS.md" && r.kind === "instructions",
  );
  const claude = result.resources.find(
    (r) => r.path === "CLAUDE.md" && r.kind === "instructions",
  );
  if (
    scope === "project" &&
    agents &&
    claude &&
    agents.digest !== claude.digest
  ) {
    agents.targets = ["codex", "cursor"];
    claude.targets = ["claude"];
    result.warnings.push(
      "AGENTS.md and CLAUDE.md differ. Their instructions will retain their tool-specific scope; edit the imported fragments to consolidate policy deliberately.",
    );
  }
  const mcpPaths = mcpLocations(scope === "user");
  for (const path of mcpPaths)
    await visit(path, async () => {
      const file = await source.file(path);
      const doc = path.endsWith(".toml")
        ? TOML.parse(file.content.toString("utf8"))
        : JSON.parse(file.content.toString("utf8"));
      const key = path.endsWith(".toml") ? "mcp_servers" : "mcpServers";
      if (!doc || typeof doc !== "object" || Array.isArray(doc))
        throw new Error("Invalid config");
      const raw = doc[key];
      if (!raw) return;
      if (typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid MCP map");
      let complete = Object.keys(doc).every((k) => k === key);
      for (const [name, server] of Object.entries(raw)) {
        const serverId = id(`${path}#${name}`);
        if (exclude.has(serverId)) {
          result.excluded.push(serverId);
          complete = false;
          continue;
        }
        try {
          const normalized = JSON.parse(
            restoreMcpSource(
              "import.json",
              Buffer.from(JSON.stringify({ mcpServers: { [name]: server } })),
            ).toString("utf8"),
          ).mcpServers[name] as McpServer;
          // Canonicalize omitted optional empty fields as equivalent to their defaults.
          if ("command" in normalized) {
            if (!normalized.args?.length) delete normalized.args;
            if (normalized.envFrom && !Object.keys(normalized.envFrom).length)
              delete normalized.envFrom;
          }
          if (
            ("command" in normalized &&
              normalized.env &&
              Object.keys(normalized.env).length) ||
            ("url" in normalized &&
              normalized.headers &&
              Object.keys(normalized.headers).length)
          )
            result.warnings.push(
              `${serverId}: literal environment/header values will be copied to the new source. Review credentials before committing.`,
            );
          result.resources.push({
            id: serverId,
            kind: "mcp",
            scope,
            path,
            name,
            server: normalized,
            files: new Map(),
            digest: fingerprint(canonicalMcp(normalized)),
          });
        } catch {
          complete = false;
          result.issues.push({
            source: serverId,
            message:
              "This MCP server cannot be translated without losing settings. Edit it or explicitly exclude it.",
          });
        }
      }
      observe(path, file, complete);
      if (!complete)
        result.warnings.push(
          `${id(path)}: contains settings outside the imported MCP resources; import cannot replace this whole file.`,
        );
    });
  const pluginsSeen = new Set<string>();
  async function plugin(path: string): Promise<boolean> {
    if (pluginsSeen.has(path)) return true;
    let marker = false;
    for (const manifest of pluginManifestPaths())
      if (await present(posix.join(path, manifest))) marker = true;
    if (!marker) return false;
    const tree = await source.tree(path);
    const info = inspectPlugin(tree)!;
    observeTree(path, tree);
    pluginsSeen.add(path);
    result.resources.push({
      id: id(path),
      kind: "plugin",
      scope,
      path,
      name: info.name,
      files: tree,
      digest: treeDigest(tree),
      targets: info.targets,
    });
    return true;
  }
  for (const directory of [...skillLocations(), ".codex/skills"])
    await visit(directory, async () => {
      for (const entry of (
        await readdir(await confinedPath(root, directory), {
          withFileTypes: true,
        })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const path = posix.join(directory, entry.name);
        await visit(path, async () => {
          if (await plugin(path)) return;
          const tree = await source.tree(path);
          installSkill(
            entry.name,
            tree,
            [],
            { source: "local", path },
            new OutputPlan(),
          );
          observeTree(path, tree);
          result.resources.push({
            id: id(path),
            kind: "skill",
            scope,
            path,
            name: entry.name,
            files: tree,
            digest: treeDigest(tree),
          });
        });
      }
    });
  for (const catalog of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
  ])
    await visit(catalog, async () => {
      observe(catalog, await source.file(catalog), false);
      for (const path of await pluginPaths({ catalog, mode: "native" }, source))
        await visit(
          posix.normalize(path),
          async () => {
            if (!(await plugin(posix.normalize(path))))
              throw new Error("Missing plugin");
          },
          true,
        );
    });
  async function pluginDirectory(
    directory: string,
    depth: number,
  ): Promise<void> {
    if (await plugin(directory)) return;
    if (depth === 0) {
      result.issues.push({
        source: id(directory),
        message:
          "Plugin directory depth exceeds automatic discovery; import it through a local catalog.",
      });
      return;
    }
    for (const entry of (
      await readdir(await confinedPath(root, directory), {
        withFileTypes: true,
      })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name === ".git" ||
        (!entry.isDirectory() && !entry.isSymbolicLink())
      )
        continue;
      const path = posix.join(directory, entry.name);
      await visit(path, () => pluginDirectory(path, depth - 1));
    }
  }
  for (const directory of [
    ".codex/plugins",
    ".claude/plugins",
    ".cursor/plugins",
  ])
    await visit(directory, () => pluginDirectory(directory, 6));
  for (const directory of [".cursor/rules", ".cursor/commands"]) {
    await visit(directory, async () => {
      const tree = await source.tree(directory);
      if (tree.size) {
        result.retained.push(
          ...[...tree.keys()].map((path) => `${scope}:${directory}/${path}`),
        );
        result.warnings.push(
          `${id(directory)}: kept in place with its existing Cursor behavior; these files are not translated to other tools.`,
        );
      }
    });
  }
  if (scope === "user")
    result.warnings.push(
      "User plugin caches may contain inactive packages or multiple versions. Review conflicts and exclusions before applying.",
    );
  return result;
}
