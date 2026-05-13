import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getImageName(): string {
  return process.env.COVE_IMAGE_NAME || 'cove-agent:latest';
}

export function buildContainerImage(tag?: string): string {
  const imageName = tag == null ? getImageName() : `cove-agent:${tag}`;
  const containerDir = path.resolve(__dirname, '../../container');
  const projectRoot = path.resolve(__dirname, '../..');
  const dockerfile = path.join(containerDir, 'Dockerfile');

  return `docker build -t ${imageName} -f ${dockerfile} ${projectRoot}`;
}

export function ensureImageExists(): true | string {
  const imageName = getImageName();
  const result = spawnSync('docker', ['image', 'inspect', imageName], { stdio: 'ignore' });

  if (result.error == null && result.status === 0) {
    return true;
  }

  return buildContainerImage();
}
