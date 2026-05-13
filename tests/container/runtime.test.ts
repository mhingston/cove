import { afterEach, describe, expect, it } from 'bun:test';

import {
  CONTAINER_RUNTIME_BIN,
  cleanupOrphans,
  getContainerRuntimeBin,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from '../../src/container/detect.ts';

const originalRuntimeBin = process.env.COVE_CONTAINER_RUNTIME_BIN;

afterEach(() => {
  if (originalRuntimeBin === undefined) {
    delete process.env.COVE_CONTAINER_RUNTIME_BIN;
    return;
  }

  process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntimeBin;
});

describe('container runtime', () => {
  it('exports docker as the default runtime binary', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('docker');
  });

  it('prefers COVE_CONTAINER_RUNTIME_BIN over the default runtime binary', () => {
    process.env.COVE_CONTAINER_RUNTIME_BIN = '/tmp/custom-docker';

    expect(getContainerRuntimeBin()).toBe('/tmp/custom-docker');
  });

  it('adds host gateway args on linux only', () => {
    const restoreLinux = setPlatform('linux');

    try {
      expect(hostGatewayArgs()).toEqual(['--add-host=host.docker.internal:host-gateway']);
    } finally {
      restoreLinux();
    }

    const restoreDarwin = setPlatform('darwin');

    try {
      expect(hostGatewayArgs()).toEqual([]);
    } finally {
      restoreDarwin();
    }
  });

  it('formats readonly mount args', () => {
    expect(readonlyMountArgs('/host/path', '/container/path')).toEqual([
      '-v',
      '/host/path:/container/path:ro',
    ]);
  });

  it('rejects invalid container names when stopping containers', () => {
    expect(() => stopContainer('')).toThrow(/invalid container name/i);
    expect(() => stopContainer('bad name')).toThrow(/invalid container name/i);
    expect(() => stopContainer('container;rm -rf /')).toThrow(/invalid container name/i);
  });

  it('does not throw when cleaning up orphaned cove containers', () => {
    expect(() => cleanupOrphans()).not.toThrow();
  });
});

function setPlatform(value: NodeJS.Platform): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', { value });

  return () => {
    if (originalDescriptor == null) {
      return;
    }

    Object.defineProperty(process, 'platform', originalDescriptor);
  };
}
