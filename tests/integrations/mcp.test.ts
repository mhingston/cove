import { describe, expect, it } from 'bun:test';

import {
  parseRuntimeMcpConfig,
  resolveRuntimeMcpConfig,
  serializeRuntimeMcpConfig,
} from '../../src/integrations/mcp.ts';

describe('runtime MCP config helpers', () => {
  const config = {
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    },
    imports: ['local.json'],
    settings: { timeoutMs: 5000 },
  };

  it('parses valid runtime MCP config from JSON text and ignores invalid payloads', () => {
    expect(parseRuntimeMcpConfig(JSON.stringify(config))).toEqual(config);
    expect(parseRuntimeMcpConfig('{')).toBeUndefined();
    expect(parseRuntimeMcpConfig(JSON.stringify({ imports: ['missing-servers'] }))).toBeUndefined();
  });

  it('resolves MCP config from supported aliases and raw top-level fields', () => {
    for (const agentConfig of [
      { mcp: config },
      { mcp: JSON.stringify(config) },
      { mcp_config: config },
      { mcp_config: JSON.stringify(config) },
      { mcpConfig: config },
      { mcpConfig: JSON.stringify(config) },
      {
        mcpServers: config.mcpServers,
        imports: config.imports,
        settings: config.settings,
      },
    ]) {
      expect(resolveRuntimeMcpConfig(agentConfig)).toEqual(config);
    }
  });

  it('serializes resolved runtime MCP config as JSON text', () => {
    expect(JSON.parse(serializeRuntimeMcpConfig(config) ?? 'null')).toEqual(config);
    expect(serializeRuntimeMcpConfig()).toBeUndefined();
  });
});
