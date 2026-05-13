import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { embedMemoryTexts } from '../../src/context/external.ts';

type MockTransformerOutput = {
  tolist(): unknown;
};

type MockExtractor = (texts: string[], options: Record<string, unknown>) => Promise<MockTransformerOutput>;

const originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;

function makeExtractor(vectors: Record<string, unknown>): MockExtractor {
  return async (texts: string[]) => ({
    tolist: () => texts.map((text) => vectors[text] ?? []),
  });
}

beforeEach(() => {
  delete process.env.COVE_CENTRAL_DB_PATH;
});

afterEach(() => {
  mock.restore();

  if (originalCentralDbPath === undefined) {
    delete process.env.COVE_CENTRAL_DB_PATH;
    return;
  }

  process.env.COVE_CENTRAL_DB_PATH = originalCentralDbPath;
});

describe('embedMemoryTexts', () => {
  it('uses an explicit embedTexts function without loading the runtime embedder', async () => {
    let importCount = 0;

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    const embedTexts = async (texts: string[]) => texts.map((text, index) => [text.length, index]);

    await expect(embedMemoryTexts(['alpha', 'beta'], embedTexts)).resolves.toEqual([
      [5, 0],
      [4, 1],
    ]);
    expect(importCount).toBe(0);
  });

  it('returns empty embeddings when no central db path is configured', async () => {
    let importCount = 0;

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    await expect(embedMemoryTexts(['alpha', 'beta'])).resolves.toEqual([]);
    expect(importCount).toBe(0);
  });

  it('returns empty embeddings for empty input without loading the runtime embedder', async () => {
    let importCount = 0;

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-empty-input.db';

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    await expect(embedMemoryTexts([])).resolves.toEqual([]);
    expect(importCount).toBe(0);
  });

  it('lazy-loads the runtime embedder and sanitizes numeric arrays', async () => {
    const pipelineCalls: Array<{ task: string; model: string }> = [];
    const extractorCalls: Array<{ texts: string[]; options: Record<string, unknown> }> = [];

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-sanitize.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async (task: string, model: string) => {
        pipelineCalls.push({ task, model });

        return async (texts: string[], options: Record<string, unknown>) => {
          extractorCalls.push({ texts, options });
          return {
            tolist: () => [
              [1, 2, 'skip', Infinity, 3],
              'not-an-array',
            ],
          };
        };
      },
    }));

    await expect(embedMemoryTexts(['alpha', 'beta'])).resolves.toEqual([
      [1, 2, 3],
      [],
    ]);
    expect(pipelineCalls).toEqual([
      { task: 'feature-extraction', model: 'Xenova/all-MiniLM-L6-v2' },
    ]);
    expect(extractorCalls).toEqual([
      {
        texts: ['alpha', 'beta'],
        options: { pooling: 'mean', normalize: true },
      },
    ]);
  });

  it('reuses the default embedder for repeated calls with the same central db path and reloads when the path changes', async () => {
    let pipelineCount = 0;

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => {
        pipelineCount++;

        return makeExtractor({
          alpha: [1],
          beta: [2],
          gamma: [3],
        });
      },
    }));

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-reuse-a.db';
    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([[1]]);
    await expect(embedMemoryTexts(['beta'])).resolves.toEqual([[2]]);

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-reuse-b.db';
    await expect(embedMemoryTexts(['gamma'])).resolves.toEqual([[3]]);

    expect(pipelineCount).toBe(2);
  });

  it('degrades to empty embeddings when transformer output exposes a non-callable tolist value', async () => {
    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-malformed-output.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => async () => ({
        tolist: 'not-a-function',
      }),
    }));

    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([]);
  });

  it('returns empty embeddings after a transient load failure and retries on the next call', async () => {
    let attempts = 0;

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-retry.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => {
        attempts++;

        if (attempts === 1) {
          throw new Error('transient load failure');
        }

        return makeExtractor({ alpha: [7, 8] });
      },
    }));

    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([]);
    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([[7, 8]]);
    expect(attempts).toBe(2);
  });
});
