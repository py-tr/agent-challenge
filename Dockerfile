# syntax=docker/dockerfile:1

# Use the official Ollama image as base — it ships with full CUDA support
# and is proven to use GPU on Nosana nodes. We install Node.js on top.
FROM ollama/ollama:latest AS base

# ── System dependencies + Node.js 23 ─────────────────────────────────────────
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  curl \
  unzip \
  ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_23.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install bun (required by elizaos CLI).
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod 755 /usr/local/bin/bun
ENV PATH="/root/.bun/bin:$PATH"

# Install pnpm
RUN npm install -g pnpm

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

# PULSE_DOCKER_BUILD=1 tells vite.config.ts to output to /srv/pulse-frontend
ENV PULSE_DOCKER_BUILD=1
ENV NODE_ENV=production
ENV SERVER_PORT=3000

WORKDIR /app

# ── Dependency install (cached by lockfile) ───────────────────────────────────
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN cd frontend && pnpm install --frozen-lockfile

# ── Source ────────────────────────────────────────────────────────────────────
COPY . .

# ── Build ─────────────────────────────────────────────────────────────────────
RUN pnpm compile

RUN mkdir -p /srv/pulse-frontend
RUN cd frontend && pnpm run build
RUN ls -la /srv/pulse-frontend/

# ── Runtime ───────────────────────────────────────────────────────────────────
RUN mkdir -p /app/data

EXPOSE 3000
EXPOSE 11434

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV OLLAMA_MODELS=/var/ollama/models

HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=5 \
  CMD curl -f http://localhost:3000/pulse/status || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
