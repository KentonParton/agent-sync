import TOML from "@iarna/toml";
import { z } from "zod";
import {
  nameSchema,
  type Harness,
  type Manifest,
} from "../manifest/manifest.js";
import type { Provenance, SourceResolver } from "../sources/source.js";
import type { OutputPlan } from "../sync/plan.js";
const projectLocations: Record<Harness, string> = {
  codex: ".codex/config.toml",
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
};
export function mcpLocations(user = false): string[] {
  return Object.values(projectLocations).map((path) =>
    user && path === projectLocations.claude ? ".claude.json" : path,
  );
}
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const literal = z
  .string()
  .refine(
    (v) => !v.includes("${"),
    "Use envFrom or headersFrom for environment references; interpolation is not portable",
  );
const strings = z.record(z.string(), literal);
const variables = z.record(z.string(), variable);
const serverSchema = z.union([
  z.strictObject({
    command: literal.min(1),
    args: z.array(literal).optional(),
    env: strings.optional(),
    envFrom: variables.optional(),
  }),
  z.strictObject({
    url: literal.url(),
    headers: strings.optional(),
    headersFrom: variables.optional(),
    bearerTokenEnv: variable.optional(),
  }),
]);
export const mcpSchema = z.strictObject({
  mcpServers: z.record(nameSchema, serverSchema),
});
export type McpServer = z.infer<typeof serverSchema>;
export class McpEnvironment {
  private servers = new Map<
    string,
    { server: McpServer; provenance: Provenance; targets: Harness[] }
  >();
  add(
    text: string,
    provenance: Provenance,
    targets: Harness[],
    namespace?: string,
  ) {
    const config = mcpSchema.parse(JSON.parse(text));
    for (const [name, server] of Object.entries(config.mcpServers)) {
      const key = namespace ? `${namespace}-${name}` : name;
      if (this.servers.has(key))
        throw new Error(`Duplicate MCP server: ${key}`);
      this.servers.set(key, { server, provenance, targets });
    }
  }
  async load(manifest: Manifest, sources: SourceResolver) {
    for (const spec of manifest.mcp) {
      const source = await sources.resolve(spec);
      this.add(
        (await source.file(spec.path)).content.toString("utf8"),
        source.provenance(spec.path),
        manifest.targets,
      );
    }
  }
  render(targets: Harness[], plan: OutputPlan) {
    for (const target of targets) {
      const servers: Record<string, unknown> = Object.create(null);
      const provenance: Provenance[] = [];
      for (const [name, item] of this.servers) {
        if (!item.targets.includes(target)) continue;
        servers[name] = renderServer(item.server, target);
        provenance.push(item.provenance);
      }
      if (!Object.keys(servers).length) continue;
      if (target === "codex")
        plan.text(
          projectLocations[target],
          TOML.stringify({ mcp_servers: servers } as TOML.JsonMap),
          "mcp",
          provenance,
        );
      else
        plan.text(
          projectLocations[target],
          JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
          "mcp",
          provenance,
        );
    }
  }
}
function renderServer(
  server: McpServer,
  target: Harness,
): Record<string, unknown> {
  const placeholder = (variable: string) =>
    target === "cursor" ? "${env:" + variable + "}" : "${" + variable + "}";
  if ("command" in server) {
    const env = { ...server.env };
    for (const key of Object.keys(server.envFrom ?? {}))
      if (key in env) throw new Error(`MCP env ${key} is defined twice`);
    if (target === "codex") {
      for (const [key, value] of Object.entries(server.envFrom ?? {}))
        if (key !== value)
          throw new Error(
            `Codex cannot rename environment variable ${value} to ${key}; use matching envFrom names`,
          );
      return {
        command: server.command,
        ...(server.args && { args: server.args }),
        ...(Object.keys(env).length && { env }),
        ...(server.envFrom && { env_vars: Object.values(server.envFrom) }),
      };
    }
    for (const [key, value] of Object.entries(server.envFrom ?? {}))
      env[key] = placeholder(value);
    return {
      ...(target === "claude" && { type: "stdio" }),
      command: server.command,
      ...(server.args && { args: server.args }),
      ...(Object.keys(env).length && { env }),
    };
  }
  const headers = { ...server.headers };
  const from = { ...server.headersFrom };
  const lower = [...Object.keys(headers), ...Object.keys(from)].map((k) =>
    k.toLowerCase(),
  );
  if (
    new Set(lower).size !== lower.length ||
    (server.bearerTokenEnv && lower.includes("authorization"))
  )
    throw new Error("Conflicting MCP header definitions");
  if (target === "codex")
    return {
      url: server.url,
      ...(Object.keys(headers).length && { http_headers: headers }),
      ...(Object.keys(from).length && { env_http_headers: from }),
      ...(server.bearerTokenEnv && {
        bearer_token_env_var: server.bearerTokenEnv,
      }),
    };
  for (const [key, value] of Object.entries(from))
    headers[key] = placeholder(value);
  if (server.bearerTokenEnv)
    headers.Authorization = `Bearer ${placeholder(server.bearerTokenEnv)}`;
  return {
    ...(target === "claude" && { type: "http" }),
    url: server.url,
    ...(Object.keys(headers).length && { headers }),
  };
}
