export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

type TransformerOutput = {
  tolist(): unknown;
};

let defaultEmbedderPromise: Promise<EmbedTexts | undefined> | undefined;
let defaultEmbedderKey: string | undefined;

function getDefaultEmbedderKey(): string | undefined {
  const centralDbPath = process.env.COVE_CENTRAL_DB_PATH?.trim();
  return centralDbPath ? centralDbPath : undefined;
}

function sanitizeEmbeddings(raw: unknown): number[][] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((embedding) => (
    Array.isArray(embedding)
      ? embedding.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      : []
  ));
}

async function getEmbeddings(texts: string[], embedTexts?: EmbedTexts): Promise<number[][]> {
  if (!embedTexts || texts.length === 0) {
    return [];
  }

  const embeddings = await embedTexts(texts);
  return sanitizeEmbeddings(embeddings);
}

function readTransformerOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object' || !("tolist" in output)) {
    return [];
  }

  return typeof output.tolist === 'function' ? output.tolist() : [];
}

async function loadDefaultEmbedder(): Promise<EmbedTexts | undefined> {
  const currentKey = getDefaultEmbedderKey();

  if (!currentKey) {
    defaultEmbedderKey = undefined;
    defaultEmbedderPromise = undefined;
    return undefined;
  }

  if (!defaultEmbedderPromise || defaultEmbedderKey !== currentKey) {
    defaultEmbedderKey = currentKey;
    defaultEmbedderPromise = (async () => {
      try {
        const { pipeline } = await import('@xenova/transformers');
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

        return async (texts: string[]) => {
          if (texts.length === 0) {
            return [];
          }

          const output = await extractor(texts, {
            pooling: 'mean',
            normalize: true,
          });

          return sanitizeEmbeddings(readTransformerOutput(output as TransformerOutput));
        };
      } catch {
        if (defaultEmbedderKey === currentKey) {
          defaultEmbedderPromise = undefined;
        }

        return undefined;
      }
    })();
  }

  return defaultEmbedderPromise;
}

export async function embedMemoryTexts(texts: string[], embedTexts?: EmbedTexts): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const resolvedEmbedTexts = embedTexts ?? await loadDefaultEmbedder();
  return getEmbeddings(texts, resolvedEmbedTexts);
}
