import { resolveRuntimeMcpConfig, serializeRuntimeMcpConfig } from './integrations/mcp.ts';
import { parseRuntimePrepConfigValue } from './runtime-prep-config.ts';
import type { AgentGroupRow, SessionConfig } from './shared/types.ts';

function isOneCliAuthEnabled(extraEnv: Record<string, string> | undefined): boolean {
  const rawValue = extraEnv?.COVE_ONECLI_AUTH ?? process.env.COVE_ONECLI_AUTH;

  if (rawValue == null) {
    return true;
  }

  const normalized = rawValue.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'disabled';
}

function hasOneCliGatewayEnv(): boolean {
  return (process.env.ONECLI_AGENT_NAME?.trim() ?? '') !== ''
    && (process.env.ONECLI_URL?.trim() ?? '') !== '';
}

function supportsOneCliGateway(provider: string | null): boolean {
  return provider === 'anthropic' || provider === 'auto';
}

function getOneCliGatewayProxyUrl(): string | null {
  const url = process.env.ONECLI_URL?.trim();
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.port === '10255') {
      return `${parsed.host}`;
    }
    return `${parsed.host}:10255`;
  } catch {
    return null;
  }
}

export function buildAgentGroupSessionConfig(agentGroup: Pick<AgentGroupRow, 'provider' | 'model' | 'thinking' | 'workspace' | 'permissions' | 'config'>): SessionConfig {
  const parsedConfig = parseRuntimePrepConfigValue(agentGroup.config) ?? {};
  const mcpConfig = serializeRuntimeMcpConfig(resolveRuntimeMcpConfig(parsedConfig)) ?? null;
  const extraEnv: Record<string, string> = {
    ...(parsedConfig.extra_env ?? {}),
    ...(parsedConfig.credential_profile == null ? {} : { credential_profile: parsedConfig.credential_profile }),
    ...(mcpConfig == null ? {} : { COVE_MCP_CONFIG: mcpConfig }),
  };

  const useOneCliGateway = isOneCliAuthEnabled(parsedConfig.extra_env) && hasOneCliGatewayEnv();

  if (useOneCliGateway && !supportsOneCliGateway(agentGroup.provider)) {
    const proxyUrl = getOneCliGatewayProxyUrl();
    if (proxyUrl) {
      extraEnv.HTTPS_PROXY = proxyUrl;
      extraEnv.https_proxy = proxyUrl;
      extraEnv.HTTP_PROXY = proxyUrl;
      extraEnv.http_proxy = proxyUrl;
      extraEnv.NO_PROXY = 'localhost,127.0.0.1';
      extraEnv.no_proxy = 'localhost,127.0.0.1';
    }
  }

  return {
    provider: agentGroup.provider,
    model: agentGroup.model,
    thinking_level: agentGroup.thinking,
    api_key: useOneCliGateway && supportsOneCliGateway(agentGroup.provider) ? null : parsedConfig.api_key ?? null,
    workspace: agentGroup.workspace,
    extra_env: Object.keys(extraEnv).length > 0 ? extraEnv : null,
    permissions: agentGroup.permissions,
  };
}
