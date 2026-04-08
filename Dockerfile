# syntax=docker/dockerfile:1

FROM node:23-slim AS base

# ── System dependencies ────────────────────────────────────────────────────────
# python3/make/g++ for native modules (better-sqlite3 etc.)
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

# ── Install root dependencies (includes devDeps for tsc) ──────────────────────
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Install & build frontend ──────────────────────────────────────────────────
# Copy frontend source and its own lockfile so Vite + tsc are available.
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN cd frontend && pnpm install --frozen-lockfile

COPY frontend/ ./frontend/
RUN cd frontend && pnpm run build
# dist/frontend/ now exists at /app/dist/frontend/

# ── Compile TypeScript ────────────────────────────────────────────────────────
COPY . .
RUN pnpm compile
# dist/pulse/... now exists at /app/dist/

# ── Runtime configuration ─────────────────────────────────────────────────────
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV SERVER_PORT=3000

CMD ["pnpm", "start"]
