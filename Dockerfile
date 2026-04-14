# syntax=docker/dockerfile:1

# Use CUDA runtime base so Ollama can see the GPU via NVIDIA Container Toolkit
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  curl \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 23
RUN curl -fsSL https://deb.nodesource.com/setup_23.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install Ollama binary + CUDA runner libraries from official image
# Copying /usr/lib/ollama/ is required — it contains the CUDA backend (.so files)
# that the binary dynamically loads. Without it Ollama falls back to CPU.
COPY --from=ollama/ollama:latest /usr/bin/ollama /usr/local/bin/ollama
COPY --from=ollama/ollama:latest /usr/lib/ollama/ /usr/lib/ollama/

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
# 1. Compile TypeScript → /app/dist/
RUN pnpm compile

# 2. Build React frontend to /srv/pulse-frontend/ — outside /app so
#    the Nosana volume mount cannot wipe it at runtime.
RUN mkdir -p /srv/pulse-frontend
RUN cd frontend && pnpm run build

# Verify the static files are where we expect them.
RUN ls -la /srv/pulse-frontend/

# ── Runtime ───────────────────────────────────────────────────────────────────
RUN mkdir -p /app/data

EXPOSE 3000
EXPOSE 11434

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Store Ollama models outside /app to avoid Nosana volume mount conflicts
ENV OLLAMA_MODELS=/var/ollama/models

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=5 \
  CMD curl -f http://localhost:3000/pulse/status || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
