import { posix, resolve } from "node:path";
import { z } from "zod";
import {
  nameSchema,
  relativePathSchema,
  type Harness,
  type Manifest,
  type PluginSpec,
} from "../manifest/manifest.js";
import {
  fingerprint,
  type FileTree,
  type ResolvedSource,
  type SourceResolver,
} from "../sources/source.js";
import { installSkill, selectDirectories } from "../skills/skills.js";
import type { McpEnvironment } from "../mcp/mcp.js";
import type { OutputPlan } from "../sync/plan.js";

export function pluginMarketplaceName(root: string): string {
  return `agent-sync-${fingerprint(root).slice(0, 16)}`;
}
export const PORTABLE_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const nativeManifests: Record<Harness, string> = {
  codex: ".codex-plugin/plugin.json",
  claude: ".claude-plugin/plugin.json",
  cursor: ".cursor-plugin/plugin.json",
};
const portableManifestSchema = z.strictObject({
  $schema: z.literal(PORTABLE_PLUGIN_SCHEMA),
  name: nameSchema
    .max(64)
    .refine(
      (name) => !name.includes("_"),
      "Agent Plugins names cannot contain underscores",
    ),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .strictObject({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});
const metadataSchema = z
  .object({ name: nameSchema, version: z.string().optional() })
  .passthrough();
export function inspectPlugin(
  tree: FileTree,
): { name: string; targets: Harness[] } | undefined {
  const portable = tree.get("plugin.json");
  const native = Object.values(nativeManifests)
    .map((path) => tree.get(path))
    .find(Boolean);
  if (!portable && !native) return undefined;
  const metadata = (portable ? portableManifestSchema : metadataSchema).parse(
    JSON.parse((portable ?? native)!.content.toString("utf8")),
  );
  const targets = (Object.keys(nativeManifests) as Harness[]).filter(
    (target) => portable || tree.has(nativeManifests[target]),
  );
  for (const path of Object.values(nativeManifests)) {
    const file = tree.get(path);
    if (
      file &&
      metadataSchema.parse(JSON.parse(file.content.toString("utf8"))).name !==
        metadata.name
    )
      throw new Error("Plugin manifests disagree about their name");
  }
  return { name: metadata.name, targets };
}
export function pluginManifestPaths(): string[] {
  return ["plugin.json", ...Object.values(nativeManifests)];
}
export interface PluginInstallation {
  name: string;
  path: string;
  targets: Harness[];
  mode: PluginSpec["mode"];
  digest: string;
}
export async function composePlugins(
  manifest: Manifest,
  sources: SourceResolver,
  plan: OutputPlan,
  mcp: McpEnvironment,
  root: string,
): Promise<PluginInstallation[]> {
  const installations: PluginInstallation[] = [];
  const names = new Set<string>();
  for (const spec of manifest.plugins) {
    const source = await sources.resolve(spec);
    for (const path of await pluginPaths(spec, source)) {
      const tree = await source.tree(path);
      const portable = tree.get("plugin.json");
      const plugin = inspectPlugin(tree);
      if (!plugin) throw new Error(`Plugin ${path} has no recognized manifest`);
      const metadataFile = tree.get(
        pluginManifestPaths().find((path) => tree.has(path))!,
      )!;
      const metadata = metadataSchema.parse(
        JSON.parse(metadataFile.content.toString("utf8")),
      );
      const name = plugin.name;
      if (names.has(name)) throw new Error(`Duplicate plugin: ${name}`);
      names.add(name);
      const targets = spec.targets ?? manifest.targets;
      if (targets.some((t) => !manifest.targets.includes(t)))
        throw new Error(`Plugin ${name} requests a disabled target`);
      const provenance = source.provenance(path);
      const destination = `.agent-sync/plugins/${name}`;
      plan.tree(destination, tree, "plugin", provenance);
      if (spec.mode === "portable") {
        if (!portable || metadata.$schema !== PORTABLE_PLUGIN_SCHEMA)
          throw new Error(
            `Plugin ${name} needs an Agent Plugins 1.0 manifest for portable mode; use mode: native for host-specific plugins`,
          );
        if (
          metadata.extensions ||
          [...tree.keys()].some((p) =>
            /^(hooks|agents|commands|rules)\//.test(p),
          )
        ) {
          plan.warnings.push(
            `Plugin ${name}: host-specific extensions are preserved in ${destination} but portable mode activates only skills and MCP. Use native mode for host-specific behavior.`,
          );
        }
        const skillTree: FileTree = new Map(
          [...tree]
            .filter(([p]) => p.startsWith("skills/"))
            .map(([p, f]) => [p.slice(7), f]),
        );
        for (const [skill, files] of selectDirectories(skillTree, "SKILL.md"))
          installSkill(
            `${name}-${skill}`,
            files,
            targets,
            { ...provenance, path: posix.join(path, "skills", skill) },
            plan,
          );
        if (tree.has("mcp.json")) {
          const config = portableMcp(
            tree.get("mcp.json")!.content.toString("utf8"),
            resolve(root, destination),
          );
          mcp.add(
            JSON.stringify(config),
            { ...provenance, path: posix.join(path, "mcp.json") },
            targets,
            name,
          );
        }
      } else {
        for (const target of targets) {
          if (!plugin.targets.includes(target))
            throw new Error(
              `Plugin ${name} has no ${target} build. Supply its native manifest or an Agent Plugins manifest; conversion of hooks is not lossless.`,
            );
        }
        if (targets.includes("claude")) {
          const claudeTree = new Map(tree);
          if (!claudeTree.has(nativeManifests.claude)) {
            if (tree.has("mcp.json")) {
              const config = JSON.parse(
                tree.get("mcp.json")!.content.toString("utf8"),
              );
              for (const server of Object.values(
                config.mcpServers ?? {},
              ) as Record<string, unknown>[]) {
                if (server.type === "streamable-http") server.type = "http";
              }
              claudeTree.set(".agent-sync-mcp.json", {
                content: Buffer.from(
                  JSON.stringify({ mcpServers: config.mcpServers }).replaceAll(
                    "${PLUGIN_ROOT}",
                    "${CLAUDE_PLUGIN_ROOT}",
                  ),
                ),
                executable: false,
              });
            }
            claudeTree.set(nativeManifests.claude, {
              content: Buffer.from(
                JSON.stringify({
                  name,
                  version: metadata.version,
                  ...(tree.has("mcp.json") && {
                    mcpServers: "./.agent-sync-mcp.json",
                  }),
                }),
              ),
              executable: false,
            });
          }
          plan.tree(`.claude/skills/${name}`, claudeTree, "plugin", provenance);
        }
        if (targets.includes("codex"))
          plan.warnings.push(
            `Native plugin ${name}: run agent-sync activate codex once; restart Codex sessions after updates. The IDE extension may not load native plugins.`,
          );
        if (targets.includes("cursor"))
          plan.warnings.push(
            `Native plugin ${name}: run agent-sync activate cursor once; reload Cursor after updates. Local plugin imports must be allowed.`,
          );
      }
      const digest = fingerprint(
        [...tree]
          .map(([p, f]) => `${p}:${fingerprint(f.content)}:${f.executable}`)
          .join("\n"),
      );
      installations.push({
        name,
        path: destination,
        targets,
        mode: spec.mode,
        digest,
      });
    }
  }
  const nativeCodex = installations.filter(
    (p) => p.mode === "native" && p.targets.includes("codex"),
  );
  if (nativeCodex.length) {
    plan.text(
      ".agents/plugins/marketplace.json",
      JSON.stringify(
        {
          name: pluginMarketplaceName(root),
          plugins: nativeCodex.map((p) => ({
            name: p.name,
            source: { source: "local", path: `./${p.path}` },
            policy: { installation: "AVAILABLE", authentication: "ON_USE" },
            category: "Productivity",
          })),
        },
        null,
        2,
      ) + "\n",
      "plugin",
      [],
    );
  }
  return installations;
}
export async function pluginPaths(
  spec: PluginSpec,
  source: ResolvedSource,
): Promise<string[]> {
  if (spec.catalog) {
    const catalog = z
      .object({
        plugins: z.array(
          z
            .object({
              name: nameSchema,
              source: z.union([
                relativePathSchema,
                z.object({
                  source: z.literal("local"),
                  path: relativePathSchema,
                }),
              ]),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .parse(
        JSON.parse((await source.file(spec.catalog)).content.toString("utf8")),
      );
    const entries = new Map(catalog.plugins.map((p) => [p.name, p]));
    if (entries.size !== catalog.plugins.length)
      throw new Error(`Duplicate entries in ${spec.catalog}`);
    return (spec.include ?? [...entries.keys()]).map((name) => {
      const entry = entries.get(name);
      if (!entry)
        throw new Error(`Plugin ${name} not found in ${spec.catalog}`);
      return typeof entry.source === "string"
        ? entry.source
        : entry.source.path;
    });
  }
  const path = spec.path!;
  const tree = await source.tree(path);
  if (
    tree.has("plugin.json") ||
    Object.values(nativeManifests).some((p) => tree.has(p))
  ) {
    if (spec.include)
      throw new Error(
        "include applies to plugin collections or catalogs, not a single plugin",
      );
    return [path];
  }
  const names = [
    ...new Set(
      [...tree.keys()]
        .filter((p) => p.endsWith("/plugin.json"))
        .map((p) => p.split("/")[0]!),
    ),
  ];
  return (spec.include ?? names).map((name) => {
    nameSchema.parse(name);
    if (!names.includes(name))
      throw new Error(`Missing plugin ${name} under ${path}`);
    return posix.join(path, name);
  });
}
// Translate the standard's portable subset explicitly. Unsupported substitutions fail before any writes.
function portableMcp(text: string, destination: string) {
  const input = z
    .object({
      $schema: z.literal(
        "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      ),
      mcpServers: z.record(nameSchema, z.record(z.string(), z.unknown())),
    })
    .strict()
    .parse(JSON.parse(text));
  const servers: Record<string, unknown> = Object.create(null);
  for (const [name, raw] of Object.entries(input.mcpServers)) {
    const { type, ...server } = raw;
    if (!["stdio", "streamable-http"].includes(String(type)))
      throw new Error(
        `Plugin MCP ${name}: transport ${String(type)} is not portable to all targets`,
      );
    if (server.cwd)
      throw new Error(`Plugin MCP ${name}: cwd requires native mode`);
    const replaceRoot = (value: unknown): unknown => {
      if (typeof value === "string")
        return value.replaceAll("${PLUGIN_ROOT}", destination);
      if (Array.isArray(value)) return value.map(replaceRoot);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, replaceRoot(v)]),
        );
      return value;
    };
    servers[name] = replaceRoot(server);
  }
  return { mcpServers: servers };
}
