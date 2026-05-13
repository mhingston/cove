import { afterEach, describe, expect, it } from 'bun:test';

import { buildContainerImage, ensureImageExists, getImageName } from '../../src/container/image.ts';

const originalImageName = process.env.COVE_IMAGE_NAME;

afterEach(() => {
  if (originalImageName === undefined) {
    delete process.env.COVE_IMAGE_NAME;
    return;
  }

  process.env.COVE_IMAGE_NAME = originalImageName;
});

describe('container image', () => {
  it('defaults the image name to cove-agent:latest', () => {
    delete process.env.COVE_IMAGE_NAME;

    expect(getImageName()).toBe('cove-agent:latest');
  });

  it('uses COVE_IMAGE_NAME when configured', () => {
    process.env.COVE_IMAGE_NAME = 'registry.example/cove:test';

    expect(getImageName()).toBe('registry.example/cove:test');
  });

  it('buildContainerImage returns a docker build command rooted at the project container Dockerfile', () => {
    const command = buildContainerImage('phase3');

    expect(command).toContain('docker build');
    expect(command).toContain('-t cove-agent:phase3');
    expect(command).toContain('/container/Dockerfile');
  });

  it('ensureImageExists returns either true or a docker build command', () => {
    const result = ensureImageExists();

    if (result === true) {
      expect(result).toBe(true);
      return;
    }

    expect(result).toContain('docker build');
  });
});
