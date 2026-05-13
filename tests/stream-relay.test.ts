import { afterEach, describe, expect, it } from 'bun:test';

import {
  completeStreamRelay,
  failStreamRelay,
  isStreamRelayCallbackMetadata,
  openStreamRelay,
  pushStreamRelayChunk,
} from '../src/stream-relay.ts';

const originalCallbackBaseUrl = process.env.COVE_STREAM_CALLBACK_BASE_URL;

afterEach(() => {
  if (originalCallbackBaseUrl === undefined) {
    delete process.env.COVE_STREAM_CALLBACK_BASE_URL;
    return;
  }

  process.env.COVE_STREAM_CALLBACK_BASE_URL = originalCallbackBaseUrl;
});

describe('stream relay', () => {
  it('rewrites localhost callback metadata to host.docker.internal', () => {
    const relay = openStreamRelay('http://127.0.0.1:4111');

    expect(isStreamRelayCallbackMetadata(relay.metadata)).toBe(true);
    expect(relay.metadata.chunk_url).toContain('http://host.docker.internal:4111/internal/streams/');
    expect(relay.metadata.complete_url).toContain('/complete');
    expect(relay.metadata.error_url).toContain('/error');
    expect(completeStreamRelay(relay.id)).toBe(true);
  });

  it('prefers COVE_STREAM_CALLBACK_BASE_URL when configured', () => {
    process.env.COVE_STREAM_CALLBACK_BASE_URL = 'https://relay.example/base/';

    const relay = openStreamRelay('http://127.0.0.1:4111');

    expect(relay.metadata.chunk_url).toContain('https://relay.example/base/internal/streams/');
    expect(relay.metadata.complete_url).toContain('https://relay.example/base/internal/streams/');
    expect(relay.metadata.error_url).toContain('https://relay.example/base/internal/streams/');
    expect(completeStreamRelay(relay.id)).toBe(true);
  });

  it('delivers pushed chunks and completes the stream', async () => {
    const relay = openStreamRelay('http://localhost:4111');
    const iterator = relay.stream[Symbol.asyncIterator]();

    const first = iterator.next();
    expect(pushStreamRelayChunk(relay.id, 'Hello')).toBe(true);
    expect(await first).toEqual({ value: 'Hello', done: false });

    const second = iterator.next();
    expect(pushStreamRelayChunk(relay.id, ' world')).toBe(true);
    expect(await second).toEqual({ value: ' world', done: false });

    const done = iterator.next();
    expect(completeStreamRelay(relay.id)).toBe(true);
    expect(await done).toEqual({ value: undefined, done: true });
  });

  it('propagates relay failures to stream consumers', async () => {
    const relay = openStreamRelay('http://localhost:4111');
    const iterator = relay.stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    expect(failStreamRelay(relay.id, new Error('boom'))).toBe(true);

    await expect(pending).rejects.toThrow('boom');
  });
});
