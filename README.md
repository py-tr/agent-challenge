# Nosana Mastra Agent Template

A production-ready starter template for building and deploying AI agents using **Mastra** on the **Nosana decentralized compute network**.

## Overview

This template provides everything you need to build intelligent AI agents with a modern web interface and deploy them on decentralized infrastructure. Built with [Mastra](https://mastra.ai), [CopilotKit](https://copilotkit.ai), and Next.js.

### What's Included

- **Mastra framework** - AI agent orchestration and workflow management
- **Tool calling system** - Connect your agent to external services and APIs
- **MCP (Model Context Protocol)** support - Enhanced agent capabilities
- **Modern Next.js frontend** - Beautiful UI for interacting with your agent
- **Docker configuration** - Ready for containerized deployment
- **Nosana deployment configs** - Deploy to decentralized GPU infrastructure

### Agent Use Cases

This template can be adapted for various AI agent applications:

- 🤖 **Personal Assistant** - Schedule management, email drafting, task automation
- 📊 **Data Analyst Agent** - Fetch financial data, generate insights, create visualizations
- 🌐 **Web Researcher** - Aggregate information from multiple sources, summarize findings
- 🛠️ **DevOps Helper** - Monitor services, automate deployments, manage infrastructure
- 🎨 **Content Creator** - Generate social media posts, blog outlines, marketing copy
- 🔍 **Smart Search** - Multi-source search with AI-powered result synthesis
- 💬 **Customer Support Bot** - Answer FAQs, ticket routing, knowledge base queries

## Getting Started

### Prerequisites

- Node.js 18+ and pnpm
- Docker (for deployment)
- Git

### Quick Start

```bash
# Clone this repository
git clone https://github.com/YOUR-USERNAME/nosana-mastra-template
cd nosana-mastra-template

# Copy environment variables
cp .env.example .env

# Install dependencies
pnpm i

# Start the development servers
pnpm run dev:ui      # Start UI server (port 3000)
pnpm run dev:agent   # Start Mastra agent server (port 4111)
```

Open <http://localhost:3000> to see your agent frontend.
Open <http://localhost:4111> to access the Mastra Agent Playground.

### Configure Your LLM

Choose your preferred LLM provider to power your agent:

#### Option A: Local LLM with Ollama (Recommended for Development)

Run Ollama locally (requires [Ollama installed](https://ollama.com/download)):

```bash
ollama pull qwen3:0.6b
ollama serve
```

Update your `.env`:
```env
OLLAMA_API_URL=http://127.0.0.1:11434/api
MODEL_NAME_AT_ENDPOINT=qwen3:0.6b
```

#### Option B: OpenAI

Add your OpenAI API key to `.env` and uncomment the OpenAI configuration in `src/mastra/agents/index.ts`:

```env
OPENAI_API_KEY=your-openai-api-key
```

#### Option C: Custom Endpoint

Use any OpenAI-compatible endpoint:

```env
OLLAMA_API_URL=https://your-custom-endpoint.com/api
MODEL_NAME_AT_ENDPOINT=your-model-name
```

## Development Guide

### 1. Build Your Agent

Implement your agent logic in the Mastra framework:

1. **Define your tools** - Create custom functions in `src/mastra/tools/`
2. **Configure your agent** - Update agent behavior in `src/mastra/agents/`
3. **Test locally** - Validate functionality at http://localhost:3000 and http://localhost:4111

### 2. Customize the Frontend

Modify the Next.js frontend to match your agent's functionality:

- Update UI components in `src/app/`
- Customize the chat interface
- Add custom visualizations or controls

### 3. Containerize Your Application

Package your agent for deployment:

```bash
# Build your Docker container
docker build -t yourusername/nosana-mastra-agent:latest .

# Test the container locally
docker run -p 3000:3000 yourusername/nosana-mastra-agent:latest

# Push to Docker Hub
docker login
docker push yourusername/nosana-mastra-agent:latest
```

The provided `Dockerfile` bundles:
- Your Mastra agent
- Frontend interface
- LLM runtime (all-in-one container)

### 4. Deploy to Nosana

Deploy your containerized agent to Nosana's decentralized GPU network (see deployment section below).

## Project Structure

```
├── src/
│   ├── app/              # Next.js frontend
│   ├── mastra/           # Mastra agent configuration
│   │   ├── agents/       # Agent definitions
│   │   └── tools/        # Custom tool implementations
│   └── lib/              # Shared utilities
├── nos_job_def/          # Nosana deployment configs
├── Dockerfile            # Container configuration
└── .env.example          # Environment variables template
```

## 🚀 Deploying to Nosana

Deploy your AI agent to Nosana's decentralized GPU network for production use.

### Method 1: Using Nosana Dashboard (Easiest)

1. Open [Nosana Dashboard](https://dashboard.nosana.com/deploy)
2. Click `Expand` to open the job definition editor
3. Edit `nos_job_def/nosana_mastra_job_definition.json` with your Docker image:
   ```json
   {
     "image": "yourusername/nosana-mastra-agent:latest"
   }
   ```
4. Copy and paste the edited job definition into the dashboard
5. Select your preferred GPU type
6. Click `Deploy`

### Method 2: Using Nosana CLI

Install the Nosana CLI and deploy from your terminal:

```bash
# Install Nosana CLI
npm install -g @nosana/cli

# Deploy your agent
nosana job post --file ./nos_job_def/nosana_mastra_job_definition.json --market nvidia-3090 --timeout 30
```

### Deployment Configuration

The job definition file includes:
- Docker image reference
- Resource requirements (GPU, memory, CPU)
- Network exposure settings
- Environment variables

Modify `nos_job_def/nosana_mastra_job_definition.json` to customize your deployment.

## Why Deploy on Nosana?

- **Decentralized Infrastructure** - Run on distributed GPU nodes worldwide
- **Cost-Effective** - Competitive pricing for GPU compute
- **Censorship-Resistant** - No single point of control or failure
- **Scalable** - Easy to scale your agent across multiple nodes
- **Transparent** - On-chain job execution and verification

## 📚 Documentation & Resources

### Framework Documentation
- [Mastra Documentation](https://mastra.ai/en/docs) - Complete guide to the Mastra framework
- [Mastra Agents Overview](https://mastra.ai/en/docs/agents/overview) - Understanding AI agents
- [Mastra Tool Calling](https://mastra.ai/en/docs/agents/tools) - Implementing custom tools
- [Build an AI Stock Agent Guide](https://mastra.ai/en/guides/guide/stock-agent) - Complete tutorial
- [CopilotKit Documentation](https://docs.copilotkit.ai) - Frontend AI integration

### Platform Documentation
- [Nosana Documentation](https://docs.nosana.io) - Complete Nosana platform guide
- [Nosana CLI](https://github.com/nosana-ci/nosana-cli) - Command-line deployment
- [Nosana SDK](https://github.com/nosana-ci/nosana-sdk) - JavaScript SDK

### Additional Resources
- [Next.js Documentation](https://nextjs.org/docs) - Next.js features and API
- [Docker Documentation](https://docs.docker.com) - Container best practices

## 🆘 Support & Community

Need help or want to connect with other builders?

- **Discord** - Join [Nosana Discord](https://nosana.com/discord) for technical support
- **Twitter/X** - Follow [@nosana_ai](https://x.com/nosana_ai) for updates
- **GitHub** - Report issues or contribute to the repos

## Contributing

Contributions are welcome! Feel free to:
- Submit bug reports or feature requests
- Improve documentation
- Share your agent implementations
- Contribute code improvements

## License

This template is open source and available under the MIT License.

---

**Built with Mastra • Deployed on Nosana • Powered by decentralized AI**


