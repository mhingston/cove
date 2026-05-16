export type ProviderEnvPassthroughEntry = {
  name: string;
  required?: boolean;
};

export type ProviderFileEnvPassthroughEntry = {
  name: string;
  kind: 'file' | 'directory';
  required?: boolean;
};

export type ProviderCredentialDirMount = {
  relativeHostPath: string;
  containerPath: string;
};

export const BUILT_IN_PROVIDER_ENV_PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'CLOUDFLARE_API_KEY',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
] as const;

export const BUILT_IN_PROVIDER_FILE_ENV_PASSTHROUGH = [
  { name: 'AWS_WEB_IDENTITY_TOKEN_FILE', kind: 'file', required: false },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', kind: 'file', required: false },
] as const satisfies readonly ProviderFileEnvPassthroughEntry[];

export const BUILT_IN_PROVIDER_CREDENTIAL_DIR_MOUNTS = [
  { relativeHostPath: '.aws', containerPath: '/root/.aws' },
  { relativeHostPath: '.config/gcloud', containerPath: '/root/.config/gcloud' },
] as const satisfies readonly ProviderCredentialDirMount[];
