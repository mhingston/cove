export type StreamRelayCallbackMetadata = {
  chunk_url: string;
  complete_url: string;
  error_url: string;
};

type Queue<T> = {
  push(value: T): void;
  finish(): void;
  fail(error: unknown): void;
  next(): Promise<IteratorResult<T>>;
};

function streamQueue<T>(): Queue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let done = false;
  let error: unknown;

  return {
    push(value: T): void {
      if (done || error) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }

      values.push(value);
    },
    finish(): void {
      if (done || error) {
        return;
      }

      done = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    },
    fail(nextError: unknown): void {
      if (done || error) {
        return;
      }

      error = nextError;
      while (waiters.length > 0) {
        waiters.shift()?.reject(nextError);
      }
    },
    async next(): Promise<IteratorResult<T>> {
      if (values.length > 0) {
        return { value: values.shift() as T, done: false };
      }

      if (error) {
        const nextError = error;
        error = undefined;
        throw nextError;
      }

      if (done) {
        return { value: undefined, done: true };
      }

      return new Promise<IteratorResult<T>>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

const relays = new Map<string, Queue<string>>();

function resolveRelayBaseUrl(origin: string): string {
  const override = process.env.COVE_STREAM_CALLBACK_BASE_URL;

  if (override) {
    return override.replace(/\/$/, '');
  }

  const url = new URL(origin);

  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)) {
    url.hostname = 'host.docker.internal';
  }

  return url.origin;
}

function callbackUrl(baseUrl: string, relayId: string, action: 'chunk' | 'complete' | 'error'): string {
  return `${resolveRelayBaseUrl(baseUrl)}/internal/streams/${relayId}/${action}`;
}

export function isStreamRelayCallbackMetadata(value: unknown): value is StreamRelayCallbackMetadata {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as StreamRelayCallbackMetadata).chunk_url === 'string'
      && typeof (value as StreamRelayCallbackMetadata).complete_url === 'string'
      && typeof (value as StreamRelayCallbackMetadata).error_url === 'string',
  );
}

export function openStreamRelay(baseUrl: string): {
  id: string;
  metadata: StreamRelayCallbackMetadata;
  stream: AsyncGenerator<string, void, undefined>;
} {
  const id = crypto.randomUUID();
  const queue = streamQueue<string>();
  relays.set(id, queue);

  return {
    id,
    metadata: {
      chunk_url: callbackUrl(baseUrl, id, 'chunk'),
      complete_url: callbackUrl(baseUrl, id, 'complete'),
      error_url: callbackUrl(baseUrl, id, 'error'),
    },
    stream: (async function* (): AsyncGenerator<string, void, undefined> {
      try {
        while (true) {
          const next = await queue.next();

          if (next.done) {
            break;
          }

          yield next.value;
        }
      } finally {
        relays.delete(id);
      }
    })(),
  };
}

export function pushStreamRelayChunk(id: string, token: string): boolean {
  const relay = relays.get(id);

  if (!relay) {
    return false;
  }

  relay.push(token);
  return true;
}

export function completeStreamRelay(id: string): boolean {
  const relay = relays.get(id);

  if (!relay) {
    return false;
  }

  relay.finish();
  relays.delete(id);
  return true;
}

export function failStreamRelay(id: string, error: unknown): boolean {
  const relay = relays.get(id);

  if (!relay) {
    return false;
  }

  relay.fail(error);
  relays.delete(id);
  return true;
}
