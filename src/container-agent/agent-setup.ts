import fs from 'node:fs';

export type SupportedContainerAgentProvider = string;

export type ContainerAgentSetupOptions = {
  provider: string;
  model: string;
  apiKey?: string | null;
  sessionId?: string | null;
  sessionStateDir?: string | null;
};

export type ResolvedContainerAgentModel = {
  provider: SupportedContainerAgentProvider;
  model: string;
  id: string;
};

export type ContainerAgentSessionManagerMode = 'continueRecent' | 'in-memory';

export type ContainerAgentSetupDeps = {
  createInMemoryAuth(input: {
    provider: SupportedContainerAgentProvider;
    apiKey?: string | null;
  }): Promise<unknown>;
  createModel(input: ResolvedContainerAgentModel): Promise<unknown>;
  createSessionManager(input: {
    mode: ContainerAgentSessionManagerMode;
    sessionId?: string;
    sessionStateDir?: string;
  }): Promise<unknown>;
  createSession(input: {
    auth: unknown;
    model: unknown;
    sessionManager: unknown;
    sessionManagerMode: ContainerAgentSessionManagerMode;
  }): Promise<unknown>;
};

export type ContainerAgentSetupResult = {
  auth: unknown;
  model: unknown;
  sessionManager: unknown;
  sessionManagerMode: ContainerAgentSessionManagerMode;
  session: unknown;
};

function normalizeText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function toSupportedProvider(value: string): SupportedContainerAgentProvider {
  const provider = normalizeText(value);

  if (provider == null) {
    throw new Error('Container agent provider is required.');
  }

  return provider;
}

export function resolveContainerAgentModel(options: {
  provider: string;
  model: string;
}): ResolvedContainerAgentModel {
  const provider = normalizeText(options.provider);
  const model = normalizeText(options.model);

  if (provider == null) {
    throw new Error('Container agent provider is required.');
  }

  if (model == null) {
    throw new Error('Container agent model is required.');
  }

  if (provider === 'auto') {
    const separatorIndex = model.indexOf('/');

    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      throw new Error("Container agent model must include an explicit provider when provider is 'auto'.");
    }

    const namespacedProvider = toSupportedProvider(model.slice(0, separatorIndex));
    const providerModel = model.slice(separatorIndex + 1);

    return {
      provider: namespacedProvider,
      model: providerModel,
      id: `${namespacedProvider}/${providerModel}`,
    };
  }

  const supportedProvider = toSupportedProvider(provider);
  const resolvedModel = model.startsWith(`${supportedProvider}/`)
    ? model.slice(supportedProvider.length + 1)
    : model;

  if (normalizeText(resolvedModel) == null) {
    throw new Error('Container agent model is required.');
  }

  return {
    provider: supportedProvider,
    model: resolvedModel,
    id: `${supportedProvider}/${resolvedModel}`,
  };
}

export function resolveSessionManagerMode(options: {
  sessionId?: string | null;
  sessionStateDir?: string | null;
}): ContainerAgentSessionManagerMode {
  const sessionId = normalizeText(options.sessionId);
  const sessionStateDir = normalizeText(options.sessionStateDir);

  if (sessionId == null || sessionStateDir == null) {
    return 'in-memory';
  }

  try {
    return fs.statSync(sessionStateDir).isDirectory() ? 'continueRecent' : 'in-memory';
  } catch {
    return 'in-memory';
  }
}

export async function setupContainerAgent(
  options: ContainerAgentSetupOptions,
  deps: ContainerAgentSetupDeps,
): Promise<ContainerAgentSetupResult> {
  const resolvedModel = resolveContainerAgentModel({
    provider: options.provider,
    model: options.model,
  });
  const apiKey = normalizeText(options.apiKey) ?? null;
  const sessionId = normalizeText(options.sessionId);
  const sessionStateDir = normalizeText(options.sessionStateDir);
  const sessionManagerMode = resolveSessionManagerMode({ sessionId, sessionStateDir });
  const auth = await deps.createInMemoryAuth({
    provider: resolvedModel.provider,
    apiKey,
  });
  const model = await deps.createModel(resolvedModel);
  const sessionManager = await deps.createSessionManager({
    mode: sessionManagerMode,
    ...(sessionManagerMode === 'continueRecent'
      ? {
          sessionId,
          sessionStateDir,
        }
      : {}),
  });
  const session = await deps.createSession({
    auth,
    model,
    sessionManager,
    sessionManagerMode,
  });

  return {
    auth,
    model,
    sessionManager,
    sessionManagerMode,
    session,
  };
}
