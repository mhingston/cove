import type {
  ProviderEnvPassthroughEntry,
  ProviderFileEnvPassthroughEntry,
} from './container/provider-manifest.ts';

export type RuntimePrepConfig = {
  api_key?: string;
  credential_profile?: string;
  extra_env?: Record<string, string>;
  provider_env_passthrough?: ProviderEnvPassthroughEntry[];
  provider_file_env_passthrough?: ProviderFileEnvPassthroughEntry[];
  mcp?: unknown;
  mcp_config?: unknown;
  mcpConfig?: unknown;
  mcpServers?: unknown;
  imports?: unknown;
  settings?: unknown;
};

const ALLOWED_KEYS = new Set([
  'api_key',
  'credential_profile',
  'extra_env',
  'provider_env_passthrough',
  'provider_file_env_passthrough',
  'mcp',
  'mcp_config',
  'mcpConfig',
  'mcpServers',
  'imports',
  'settings',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid agent group config: ${message}`);
}

function normalizeStringRecord(value: unknown, fieldName: string): Record<string, string> {
  if (!isRecord(value)) {
    fail(`${fieldName} must be an object`);
  }

  const normalized: Record<string, string> = {};

  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') {
      fail(`${fieldName}.${key} must be a string`);
    }

    normalized[key] = candidate;
  }

  return normalized;
}

function normalizeProviderEnvPassthrough(value: unknown): ProviderEnvPassthroughEntry[] {
  if (!Array.isArray(value)) {
    fail('provider_env_passthrough must be an array');
  }

  const normalized: ProviderEnvPassthroughEntry[] = [];
  const names = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      fail(`provider_env_passthrough[${index}].name must be a non-empty string`);
    }

    const name = entry.name.trim();
    if (name === '') {
      fail(`provider_env_passthrough[${index}].name must be a non-empty string`);
    }

    if (names.has(name)) {
      fail(`duplicate passthrough name: ${name}`);
    }

    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      fail(`provider_env_passthrough[${index}].required must be a boolean if provided`);
    }

    names.add(name);
    normalized.push({
      name,
      required: typeof entry.required === 'boolean' ? entry.required : true,
    });
  }

  return normalized;
}

function normalizeProviderFileEnvPassthrough(value: unknown): ProviderFileEnvPassthroughEntry[] {
  if (!Array.isArray(value)) {
    fail('provider_file_env_passthrough must be an array');
  }

  const normalized: ProviderFileEnvPassthroughEntry[] = [];
  const names = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      fail(`provider_file_env_passthrough[${index}].name must be a non-empty string`);
    }

    const name = entry.name.trim();
    if (name === '') {
      fail(`provider_file_env_passthrough[${index}].name must be a non-empty string`);
    }

    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      fail(`provider_file_env_passthrough[${index}].kind must be 'file' or 'directory'`);
    }

    if (names.has(name)) {
      fail(`duplicate passthrough name: ${name}`);
    }

    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      fail(`provider_file_env_passthrough[${index}].required must be a boolean if provided`);
    }

    names.add(name);
    normalized.push({
      name,
      kind: entry.kind,
      required: typeof entry.required === 'boolean' ? entry.required : true,
    });
  }

  return normalized;
}

export function normalizeRuntimePrepConfig(value: unknown): RuntimePrepConfig | null {
  if (value == null) {
    return null;
  }

  if (!isRecord(value)) {
    fail('config must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(`unsupported key: ${key}`);
    }
  }

  const config: RuntimePrepConfig = {};

  if (value.api_key !== undefined) {
    if (typeof value.api_key !== 'string') {
      fail('api_key must be a string');
    }

    config.api_key = value.api_key;
  }

  if (value.credential_profile !== undefined) {
    if (typeof value.credential_profile !== 'string') {
      fail('credential_profile must be a string');
    }

    config.credential_profile = value.credential_profile;
  }

  if (value.extra_env !== undefined) {
    config.extra_env = normalizeStringRecord(value.extra_env, 'extra_env');
  }

  if (value.provider_env_passthrough !== undefined) {
    config.provider_env_passthrough = normalizeProviderEnvPassthrough(value.provider_env_passthrough);
  }

  if (value.provider_file_env_passthrough !== undefined) {
    config.provider_file_env_passthrough = normalizeProviderFileEnvPassthrough(value.provider_file_env_passthrough);
  }

  const declaredNames = new Set(config.provider_env_passthrough?.map((entry) => entry.name) ?? []);
  for (const entry of config.provider_file_env_passthrough ?? []) {
    if (declaredNames.has(entry.name)) {
      fail(`duplicate passthrough name: ${entry.name}`);
    }

    if (config.extra_env?.[entry.name] != null) {
      fail(`extra_env must not define provider file passthrough name: ${entry.name}`);
    }
  }

  if (value.mcp !== undefined) {
    config.mcp = value.mcp;
  }

  if (value.mcp_config !== undefined) {
    config.mcp_config = value.mcp_config;
  }

  if (value.mcpConfig !== undefined) {
    config.mcpConfig = value.mcpConfig;
  }

  if (value.mcpServers !== undefined) {
    config.mcpServers = value.mcpServers;
  }

  if (value.imports !== undefined) {
    config.imports = value.imports;
  }

  if (value.settings !== undefined) {
    config.settings = value.settings;
  }

  return config;
}

export function parseRuntimePrepConfigValue(configValue: string | null): RuntimePrepConfig | null {
  if (typeof configValue !== 'string' || configValue.trim() === '') {
    return null;
  }

  try {
    return normalizeRuntimePrepConfig(JSON.parse(configValue) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid agent group config:')) {
      throw error;
    }

    fail('config must be valid JSON');
  }
}
