import type { Api } from '@earendil-works/pi-ai';

interface NineRouterProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  authHeader?: boolean;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
  }>;
}

export interface NineRouterProviderModels {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const NINE_ROUTER_MODELS: NineRouterProviderModels[] = [
  {
    id: 'cc/claude-opus-4-7',
    name: 'Claude Opus 4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: 'cx/gpt-5.4',
    name: 'GPT-5.4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: 'gc/gemini-ultra',
    name: 'Gemini Ultra',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: 'cc/claude-sonnet-4-7',
    name: 'Claude Sonnet 4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: 'cx/gpt-4.5',
    name: 'GPT-4.5',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
];

export function registerNineRouterProvider(
  modelRegistry: {
    registerProvider(providerName: string, config: ProviderConfigInput): void;
  },
  apiKey: string,
  baseUrl: string = 'http://host.docker.internal:20128/v1',
): void {
  const config: ProviderConfigInput = {
    name: '9router',
    baseUrl,
    apiKey,
    api: 'openai-responses',
    authHeader: true,
    models: NINE_ROUTER_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      api: 'openai-responses' as Api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };

  modelRegistry.registerProvider('9router', config);
}

export function isNineRouterProvider(provider: string): boolean {
  return provider === '9router';
}