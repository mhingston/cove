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

export function buildAgentGroupSessionConfig(agentGroup: Pick<AgentGroupRow, 'provider' | 'model' | 'thinking' | 'workspace' | 'permissions' | 'config'>): SessionConfig {
  const parsedConfig = parseRuntimePrepConfigValue(agentGroup.config) ?? {};
  const mcpConfig = serializeRuntimeMcpConfig(resolveRuntimeMcpConfig(parsedConfig)) ?? null;
  const extraEnv = {
    ...(parsedConfig.extra_env ?? {}),
    ...(parsedConfig.credential_profile == null ? {} : { credential_profile: parsedConfig.credential_profile }),
    ...(mcpConfig == null ? {} : { COVE_MCP_CONFIG: mcpConfig }),
  };

  const useOneCliGateway = isOneCliAuthEnabled(parsedConfig.extra_env) && hasOneCliGatewayEnv();

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
