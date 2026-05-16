# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git tini python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install lean-ctx for token-efficient MCP tools (ctx_read, ctx_shell, ctx_search, ctx_tree)
RUN curl -fsSL https://leanctx.com/install.sh | sh \
  && mv /root/.local/bin/lean-ctx /usr/local/bin/lean-ctx \
  && lean-ctx init bash >> /root/.bashrc

WORKDIR /app

COPY package.json ./package.json
COPY bun.lock ./bun.lock

RUN bun install --frozen-lockfile

COPY src/ ./src/

RUN mkdir -p /workspace && chmod 777 /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "src/container-agent/runner.ts"]
