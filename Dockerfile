# syntax=docker/dockerfile:1

FROM node:23-slim AS base

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  curl \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Install bun (required by elizaos CLI).
# Copy the binary to /usr/local/bin with world-executable permissions so it
# is accessible to any user — Nosana may run the container as a non-root user
# and /root/.bun/bin is not accessible outside of root's PATH.
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod 755 /usr/local/bin/bun
ENV PATH="/root/.bun/bin:$PATH"

# Install pnpm
RUN npm install -g pnpm

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

# Set production mode BEFORE builds so vite.config.ts routes output to
# /app/frontend-static (outside /app/dist which Nosana mounts over at runtime).
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

# 2. Build React frontend to /srv/pulse-frontend/ — completely outside /app so
#    the Nosana volume mount (which covers all of /app) cannot wipe it at runtime.
#    NODE_ENV=production is already set above; vite.config.ts routes output there.
RUN mkdir -p /srv/pulse-frontend
RUN cd frontend && pnpm run build

# Verify the static files are where we expect them.
RUN ls -la /srv/pulse-frontend/

# ── Runtime ───────────────────────────────────────────────────────────────────
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["pnpm", "start"]
