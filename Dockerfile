# syntax=docker/dockerfile:1

FROM node:23-slim AS base

# ── System dependencies ────────────────────────────────────────────────────────
# python3/make/g++ for native modules (e.g. better-sqlite3)
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  curl \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Install bun (required by elizaos CLI)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install pnpm
RUN npm install -g pnpm

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

WORKDIR /app

# ── Dependency install (cached by lockfile) ───────────────────────────────────
# Copy only manifests first so this layer is invalidated only when deps change.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN cd frontend && pnpm install --frozen-lockfile

# ── Source ────────────────────────────────────────────────────────────────────
COPY . .

# ── Build ─────────────────────────────────────────────────────────────────────
# 1. Compile TypeScript → dist/  (dist/pulse/…, dist/index.js, etc.)
RUN pnpm compile

# 2. Build React frontend → dist/frontend/  (must come AFTER pnpm compile so
#    dist/ already exists; Vite's emptyOutDir:true only wipes dist/frontend/).
RUN cd frontend && pnpm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV SERVER_PORT=3000

CMD ["pnpm", "start"]
