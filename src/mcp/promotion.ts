import TOML from "@iarna/toml";
import { mcpSchema, type McpServer } from "./mcp.js";

/** Reverse only the settings we can emit, so unknown host settings cannot be discarded. */
export function restoreMcpSource(path: string, content: Buffer): Buffer {
  const document = path.endsWith(".toml")
    ? TOML.parse(content.toString("utf8"))
    : JSON.parse(content.toString("utf8"));
  const key = path.endsWith(".toml") ? "mcp_servers" : "mcpServers";
  if (
    !document ||
    Object.keys(document).some((k) => k !== key) ||
    !document[key] ||
    typeof document[key] !== "object"
  )
    throw new Error(
      "MCP promotion cannot discard unrelated host settings; edit the source directly",
    );
  const servers: Record<string, McpServer> = Object.create(null);
  for (const [name, raw] of Object.entries(
    document[key] as Record<string, Record<string, unknown>>,
  )) {
    if (!raw || typeof raw !== "object")
      throw new Error(`Invalid MCP server ${name}`);
    const server = { ...raw };
    if (
      (server.headers !== undefined && server.http_headers !== undefined) ||
      (server.command !== undefined && server.url !== undefined)
    )
      throw new Error(`MCP ${name} has ambiguous host settings`);
    const stdio = "command" in server;
    const allowed = stdio
      ? ["type", "command", "args", "env", "env_vars"]
      : [
          "type",
          "url",
          "headers",
          "http_headers",
          "env_http_headers",
          "bearer_token_env_var",
        ];
    if (Object.keys(server).some((k) => !allowed.includes(k)))
      throw new Error(
        `MCP ${name} contains host-only settings; edit its source directly`,
      );
    if (server.type !== undefined && server.type !== (stdio ? "stdio" : "http"))
      throw new Error(`MCP ${name}: unsupported transport`);
    const variables: Record<string, string> = Object.create(null);
    const literals: Record<string, string> = Object.create(null);
    const map = stdio ? server.env : (server.headers ?? server.http_headers);
    if (map && (typeof map !== "object" || Array.isArray(map)))
      throw new Error("Invalid MCP environment or headers");
    for (const [key, value] of Object.entries(map ?? {})) {
      if (typeof value !== "string")
        throw new Error("MCP values must be strings");
      const match = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (match) variables[key] = match[1]!;
      else literals[key] = value;
    }
    if (stdio) {
      if (server.env_vars) {
        if (
          !Array.isArray(server.env_vars) ||
          server.env_vars.some((v) => typeof v !== "string")
        )
          throw new Error("Unsupported Codex env_vars");
        for (const variable of server.env_vars as string[])
          variables[variable] = variable;
      }
      servers[name] = {
        command: server.command as string,
        ...(server.args !== undefined ? { args: server.args as string[] } : {}),
        ...(Object.keys(literals).length && { env: literals }),
        ...(Object.keys(variables).length && { envFrom: variables }),
      };
    } else {
      let bearer = server.bearer_token_env_var as string | undefined;
      for (const [header, value] of Object.entries(literals)) {
        const match = /^Bearer \$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(
          value,
        );
        if (header.toLowerCase() === "authorization" && match) {
          bearer = match[1];
          delete literals[header];
        }
      }
      if (
        server.env_http_headers !== undefined &&
        (!server.env_http_headers ||
          typeof server.env_http_headers !== "object" ||
          Array.isArray(server.env_http_headers) ||
          Object.values(server.env_http_headers).some(
            (v) => typeof v !== "string",
          ))
      )
        throw new Error("Invalid Codex header environment mapping");
      Object.assign(variables, server.env_http_headers);
      servers[name] = {
        url: server.url as string,
        ...(Object.keys(literals).length && { headers: literals }),
        ...(Object.keys(variables).length && { headersFrom: variables }),
        ...(bearer && { bearerTokenEnv: bearer }),
      };
    }
  }
  return Buffer.from(
    JSON.stringify(mcpSchema.parse({ mcpServers: servers }), null, 2) + "\n",
  );
}
