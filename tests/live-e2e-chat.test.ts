import { describe, expect, it } from 'bun:test';

import {
  buildLiveChatRequestBody,
  buildLiveAgentGroupConfig,
  resolveLiveE2eConfig,
  validateLiveChatCompletionResponse,
} from '../scripts/live-e2e-chat.ts';

describe('live chat e2e script helpers', () => {
  it('skips when the live e2e opt-in is not enabled', () => {
    expect(resolveLiveE2eConfig({})).toEqual({
      enabled: false,
      reason: 'Set COVE_LIVE_E2E=1 to run the live chat E2E harness.',
    });
  });

  it('requires an explicit live model and a provider-qualified model when provider is unset or auto', () => {
    expect(() => resolveLiveE2eConfig({ COVE_LIVE_E2E: '1' })).toThrow(
      'COVE_LIVE_MODEL is required when COVE_LIVE_E2E=1',
    );

    expect(() => resolveLiveE2eConfig({
      COVE_LIVE_E2E: '1',
      COVE_LIVE_MODEL: 'claude-sonnet-4-5',
    })).toThrow(
      'COVE_LIVE_MODEL must include a provider prefix when COVE_LIVE_PROVIDER is unset or auto.',
    );

    expect(resolveLiveE2eConfig({
      COVE_LIVE_E2E: '1',
      COVE_LIVE_MODEL: 'anthropic/claude-sonnet-4-5',
    })).toEqual({
      enabled: true,
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  it('rejects mismatched live provider selectors and seeds agent-group config without Anthropic-only auth overrides', () => {
    expect(() => resolveLiveE2eConfig({
      COVE_LIVE_E2E: '1',
      COVE_LIVE_PROVIDER: 'openai',
      COVE_LIVE_MODEL: 'anthropic/claude-sonnet-4-5',
    })).toThrow(
      'Invalid live selector combination: COVE_LIVE_PROVIDER does not match the provider prefix in COVE_LIVE_MODEL.',
    );

    expect(resolveLiveE2eConfig({
      COVE_LIVE_E2E: '1',
      COVE_LIVE_PROVIDER: 'openai',
      COVE_LIVE_MODEL: 'gpt-4.1',
    })).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'gpt-4.1',
    });

    expect(JSON.parse(buildLiveAgentGroupConfig())).toEqual({
      extra_env: {},
    });
  });

  it('builds the live chat request with agent_group_id routing instead of overloading model', () => {
    expect(buildLiveChatRequestBody()).toEqual({
      agent_group_id: 'live-agent',
      thread_id: 'live-chat-e2e',
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly LIVE_E2E_OK and nothing else. Do not use any tools.',
        },
      ],
    });
  });

  it('accepts an OpenAI-compatible assistant reply and rejects empty assistant content', () => {
    expect(validateLiveChatCompletionResponse({
      id: 'chatcmpl-live-1',
      object: 'chat.completion',
      created: 1,
      model: 'live-agent',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Live reply',
          },
          finish_reason: 'stop',
        },
      ],
    })).toBe('Live reply');

    expect(() => validateLiveChatCompletionResponse({
      id: 'chatcmpl-live-1',
      object: 'chat.completion',
      created: 1,
      model: 'live-agent',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '   ',
          },
          finish_reason: 'stop',
        },
      ],
    })).toThrow('Live chat response did not include non-empty assistant content');
  });
});
