export type McpConfigParseResult = {
  config: Record<string, unknown> | null;
  error: string | null;
};

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  canToggle: boolean;
  transportLabel: string;
  detail: string;
  issue?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarizeTransport(server: Record<string, unknown>): {
  transportLabel: string;
  detail: string;
} {
  const command = asString(server.command).trim();
  const args = Array.isArray(server.args)
    ? server.args
        .map((arg) => asString(arg).trim())
        .filter(Boolean)
        .join(" ")
    : "";
  if (command) {
    return {
      transportLabel: "stdio",
      detail: [command, args].filter(Boolean).join(" "),
    };
  }

  const url = asString(server.url).trim();
  if (url) {
    const transport = asString(server.transport).trim().toLowerCase() || "http";
    const normalizedTransport = transport === "sse" ? "sse" : "http";
    return {
      transportLabel: normalizedTransport,
      detail: url,
    };
  }

  return {
    transportLabel: "unknown",
    detail: "Missing command/url",
  };
}

export function parseMcpConfig(content: string): McpConfigParseResult {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isObject(parsed)) {
      return {
        config: null,
        error: "Top-level MCP config must be a JSON object.",
      };
    }
    return { config: parsed, error: null };
  } catch (error) {
    return {
      config: null,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Invalid JSON in MCP config.",
    };
  }
}

export function summarizeMcpServers(config: Record<string, unknown>): McpServerSummary[] {
  const rawServers = isObject(config.mcpServers) ? config.mcpServers : {};

  return Object.entries(rawServers).map(([name, rawServer]) => {
    if (!isObject(rawServer)) {
      return {
        name,
        enabled: false,
        canToggle: false,
        transportLabel: "invalid",
        detail: "Invalid server definition",
        issue: "Server entry must be an object.",
      };
    }

    const enabled = rawServer.enabled !== false;
    const { transportLabel, detail } = summarizeTransport(rawServer);
    const issue =
      transportLabel === "unknown" ? "Server must define command or url." : undefined;

    return {
      name,
      enabled,
      canToggle: true,
      transportLabel,
      detail,
      issue,
    };
  });
}

export function setServerEnabled(
  config: Record<string, unknown>,
  name: string,
  enabled: boolean
): Record<string, unknown> {
  const servers = isObject(config.mcpServers) ? config.mcpServers : null;
  if (!servers) {
    throw new Error('MCP config is missing "mcpServers".');
  }

  const server = servers[name];
  if (!isObject(server)) {
    throw new Error(`Server "${name}" is not an object and cannot be toggled.`);
  }

  const nextServer = { ...server };
  if (enabled) {
    delete nextServer.enabled;
  } else {
    nextServer.enabled = false;
  }

  return {
    ...config,
    mcpServers: {
      ...servers,
      [name]: nextServer,
    },
  };
}

export function stringifyMcpConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}
