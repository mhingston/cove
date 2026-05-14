export type RuntimeMcpConfig = {
  mcpServers: Record<string, unknown>;
  imports?: unknown[];
  settings?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRuntimeMcpConfig(value: unknown): RuntimeMcpConfig | undefined {
  if (!isRecord(value) || !isRecord(value.mcpServers)) {
    return undefined;
  }

  const config: RuntimeMcpConfig = {
    mcpServers: value.mcpServers,
  };

  if (Array.isArray(value.imports)) {
    config.imports = value.imports;
  }

  if (isRecord(value.settings)) {
    config.settings = value.settings;
  }

  return config;
}

export function parseRuntimeMcpConfig(value: unknown): RuntimeMcpConfig | undefined {
  if (typeof value === 'string') {
    try {
      return normalizeRuntimeMcpConfig(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  return normalizeRuntimeMcpConfig(value);
}

export function resolveRuntimeMcpConfig(agentConfig?: Record<string, unknown>): RuntimeMcpConfig | undefined {
  if (agentConfig == null) {
    return undefined;
  }

  const directConfig = parseRuntimeMcpConfig(agentConfig.mcp)
    ?? parseRuntimeMcpConfig(agentConfig.mcp_config)
    ?? parseRuntimeMcpConfig(agentConfig.mcpConfig);

  if (directConfig != null) {
    return directConfig;
  }

  return normalizeRuntimeMcpConfig({
    mcpServers: agentConfig.mcpServers,
    imports: agentConfig.imports,
    settings: agentConfig.settings,
  });
}

export function serializeRuntimeMcpConfig(config?: RuntimeMcpConfig): string | undefined {
  if (config == null) {
    return undefined;
  }

  return JSON.stringify(config, null, 2);
}
