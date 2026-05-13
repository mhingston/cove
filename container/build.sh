#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
IMAGE_NAME="${COVE_IMAGE_NAME:-cove-agent}"
TAG="${1:-latest}"
CONTAINER_RUNTIME_BIN="${COVE_CONTAINER_RUNTIME_BIN:-docker}"

echo "Building Cove agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
"${CONTAINER_RUNTIME_BIN}" build -t "${IMAGE_NAME}:${TAG}" -f "${SCRIPT_DIR}/Dockerfile" "${PROJECT_ROOT}"
echo "Build complete!"
