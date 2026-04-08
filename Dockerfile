FROM ollama/ollama:0.7.0

# Install system dependencies
RUN apt-get update && apt-get install -y \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Install Ollama
# RUN curl -fsSL https://ollama.com/install.sh | sh

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install

# Copy the rest of the application
COPY . .

# Build the project
RUN pnpm run build

# Start Ollama service and pull the model, then run the app
CMD ["/bin/sh", "-c", "ollama serve & sleep 5 && ollama pull qwen2.5:1.5b && node .mastra/output/index.mjs"]
