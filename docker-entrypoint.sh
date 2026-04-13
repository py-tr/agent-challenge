#!/bin/bash
# docker-entrypoint.sh
# Starts Ollama, pulls the configured model, then launches the Pulse agent.
#
# Env vars:
#   OLLAMA_MODEL   — model to pull/serve (default: qwen2.5:14b)
#   SKIP_OLLAMA    — set to "true" to skip Ollama entirely and use the
#                    external inference endpoint (OPENAI_API_URL) directly.
#                    Use this when deploying to a node with a fast hosted
#                    inference endpoint so you avoid the model pull overhead.

set -e

OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b}"
OLLAMA_HOST="http://localhost:11434"

if [ "${SKIP_OLLAMA}" = "true" ]; then
  echo "[entrypoint] SKIP_OLLAMA=true — skipping Ollama, using external inference endpoint."
else
  echo "[entrypoint] Starting Ollama server..."
  ollama serve &

  # Wait for Ollama to be ready (up to 60s)
  echo "[entrypoint] Waiting for Ollama to be ready..."
  for i in $(seq 1 60); do
    if curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
      echo "[entrypoint] Ollama is ready."
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "[entrypoint] WARNING: Ollama did not start in 60s — continuing anyway."
    fi
    sleep 1
  done

  # Pull the model if not already present
  echo "[entrypoint] Pulling model: ${OLLAMA_MODEL}"
  ollama pull "${OLLAMA_MODEL}" || echo "[entrypoint] WARNING: Model pull failed — will fall back to external endpoint."
fi

echo "[entrypoint] Starting Pulse agent..."
exec pnpm start
