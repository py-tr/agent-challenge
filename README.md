# Nosana x ElizaOS Agent Challenge

![ElizaOS](./assets/NosanaXEliza.jpg)

Build your own **personal AI agent** using [ElizaOS](https://elizaos.com) and deploy it on the [Nosana](https://nosana.com) decentralized compute network. Win a share of **$3,000 USDC** in prizes.

---

## The Challenge

Inspired by [OpenClaw](https://openclaw.ai/) — the self-hosted personal AI movement — this challenge is about giving AI back to the individual. Build an agent that runs on **your own infrastructure**, handles **your own tasks**, and keeps **your own data**.

> **Theme: Personal AI Agents** — Build an AI agent that acts as a personal assistant, automate your life, or solve a real problem for yourself or your community. The use case is entirely up to you.

**Framework:** [ElizaOS](https://elizaos.com) (latest v2)
**Compute:** [Nosana](https://nosana.com) decentralized GPU network
**Model:** Qwen3.5-27B (hosted endpoint provided by Nosana)

---

## Prizes — $3,000 USDC Total

| Place | Prize |
|-------|-------|
| 🥇 1st | $1,000 USDC |
| 🥈 2nd | $750 USDC |
| 🥉 3rd | $450 USDC |
| 4th | $200 USDC |
| 5th–10th | $100 USDC each |

---

## Schedule

| Activity | Date |
|---|---|
| Teaser | March 19 (or earlier) |
| Official Announcement And Start | March 25, 12:00 UTC |
| Ams Workshop | March 25, 18:00, Amsterdam |
| Live Workshop w/ David & Denis (superteam co-marketing) | March 26 – 19:00 CET |
| Builders Challenge Singapore Workshop | Thursday, April 2, 6:00–9:00 PM GMT+8 |
| Eliza Workshop (tbd) | Thursday, April 2, 6:00–7:00 PM GMT+2 |
| **End of Builders Challenge** | **14 April** |
| **Winner Announcement** | **23 April** |

---

## What to Build

There are no strict requirements on use case — build whatever is most useful to you. Some ideas to get started:

- 🗂️ **Personal assistant** — calendar, tasks, email drafting, reminders
- 🔍 **Research agent** — web search, summarization, knowledge synthesis
- 📱 **Social media manager** — Twitter/X, Telegram, Discord automation
- 💰 **DeFi/crypto agent** — portfolio monitoring, on-chain alerts, trading insights
- 🏠 **Home automation** — smart home control, IoT integration
- 🛠️ **DevOps helper** — monitor services, automate deployments
- 🎨 **Content creator** — blog posts, social copy, creative writing

**Tip:** ElizaOS has a rich [plugin ecosystem](https://elizaos.github.io/eliza/docs/core/plugins). Explore existing plugins and templates before building from scratch — you might find 80% of what you need already exists.

---

## Getting Started

### Prerequisites

- Node.js 23+
- pnpm (`npm install -g pnpm`)
- Docker (for deployment)
- Git

### Quick Start

```bash
# Fork this repo, then clone your fork
git clone https://github.com/YOUR-USERNAME/agent-challenge
cd agent-challenge
git checkout elizaos-challenge

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your Nosana endpoint details

# Install dependencies
pnpm install

# Start your agent in development mode
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the ElizaOS built-in client.

---

## Configure Your LLM

Nosana provides a hosted **Qwen3.5-27B** endpoint for challenge participants. Update your `.env`:

```env
OPENAI_API_KEY=nosana
OPENAI_API_URL=https://<nosana-endpoint>.node.k8s.prd.nos.ci/v1
MODEL_NAME=qwen3.5-27b
```

> The Nosana endpoint URL will be shared in the [Nosana Discord](https://nosana.com/discord) when the challenge starts.

### Option B: Local Development with Ollama

```bash
ollama pull qwen3.5:27b
ollama serve
```

```env
OPENAI_API_KEY=ollama
OPENAI_API_URL=http://127.0.0.1:11434/v1
MODEL_NAME=qwen3.5:27b
```

---

## Customize Your Agent

### 1. Define your agent's character

Edit `characters/agent.character.json` to define your agent's personality, knowledge, and behavior:

```json
{
  "name": "MyAgent",
  "bio": ["Your agent's backstory and capabilities"],
  "system": "Your agent's core instructions and behavior",
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-openai"],
  "clients": ["direct"]
}
```

### 2. Add plugins

Extend your agent by adding plugins to `package.json` and your character file:

| Plugin | Use Case |
|--------|----------|
| `@elizaos/plugin-bootstrap` | Required base plugin |
| `@elizaos/plugin-openai` | OpenAI-compatible LLM (required for Nosana endpoint) |
| `@elizaos/plugin-web-search` | Web search capability |
| `@elizaos/plugin-telegram` | Telegram bot client |
| `@elizaos/plugin-discord` | Discord bot client |
| `@elizaos/plugin-twitter` | Twitter/X integration |
| `@elizaos/plugin-browser` | Browser/web automation |
| `@elizaos/plugin-sql` | Database access |

Install a plugin:
```bash
pnpm add @elizaos/plugin-web-search
```

Add it to your character file:
```json
{
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-openai", "@elizaos/plugin-web-search"]
}
```

### 3. Build custom actions (optional)

Add your own custom logic in `src/index.ts`. See the example plugin already included.

### 4. Persistent storage

SQLite is configured by default — sufficient for development and small-scale agents. For a production-grade personal agent, consider:

- A mounted volume on Nosana
- External database (PostgreSQL, PlanetScale, etc.)
- Decentralized storage (Arweave, IPFS)

---

## Deploy to Nosana

### Step 1: Build and push your Docker image

```bash
# Build
docker build -t yourusername/nosana-eliza-agent:latest .

# Test locally
docker run -p 3000:3000 --env-file .env yourusername/nosana-eliza-agent:latest

# Push to Docker Hub
docker login
docker push yourusername/nosana-eliza-agent:latest
```

### Step 2: Update the job definition

Edit `nos_job_def/nosana_eliza_job_definition.json` and replace `yourusername/nosana-eliza-agent:latest` with your image.

### Step 3: Deploy via Nosana Dashboard

1. Open [Nosana Dashboard](https://dashboard.nosana.com/deploy)
2. Click `Expand` to open the job definition editor
3. Paste the contents of `nos_job_def/nosana_eliza_job_definition.json`
4. Select your preferred compute market
5. Click `Deploy`

### Step 4: Deploy via Nosana CLI

```bash
npm install -g @nosana/cli

nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-3090 \
  --timeout 30
```

---

## Submission

1. Fork this repo and build your agent on the `elizaos-challenge` branch
2. Deploy it to Nosana and get your public URL
3. Submit via the official submission form (TODO: add link) before **April 14, 2026**

Your submission must include:
- Link to your **public GitHub fork**
- Your **Nosana deployment URL** (running agent)
- A short **description** of your agent and what it does (≤300 words)
- A **video demo** (≤3 minutes) showing the agent in action

---

## Judging Criteria

| Criterion | Weight |
|-----------|--------|
| Technical implementation (ElizaOS + Nosana integration) | 30% |
| Usefulness / real-world applicability | 30% |
| Creativity and originality | 20% |
| Code quality and documentation | 20% |

**Judges:** DevRel Lead & Ecosystem Specialist, Nosana

---

## Project Structure

```
├── characters/
│   └── agent.character.json   # Your agent's character definition
├── src/
│   └── index.ts               # Custom plugin entry point (optional)
├── nos_job_def/
│   └── nosana_eliza_job_definition.json  # Nosana deployment config
├── Dockerfile                 # Container configuration
├── .env.example               # Environment variable template
└── package.json
```

---

## Resources

### ElizaOS
- [ElizaOS Documentation](https://elizaos.github.io/eliza/docs) — Full framework docs
- [ElizaOS Plugin Directory](https://elizaos.github.io/eliza/docs/core/plugins) — Browse available plugins
- [ElizaOS GitHub](https://github.com/elizaos/eliza) — Source code and examples
- [ElizaOS Discord](https://discord.gg/elizaos) — Community support

### Nosana
- [Nosana Documentation](https://docs.nosana.io) — Platform guide
- [Nosana Dashboard](https://dashboard.nosana.com) — Deploy and manage jobs
- [Nosana CLI](https://github.com/nosana-ci/nosana-cli) — Command-line deployment
- [Nosana Discord](https://nosana.com/discord) — Support and endpoint URL

### Qwen3.5
- [Qwen3.5-27B on HuggingFace](https://huggingface.co/Qwen/Qwen3.5-27B)

---

## Support & Community

- **Discord** — Join [Nosana Discord](https://nosana.com/discord) for support, the Nosana endpoint URL, and to connect with other builders
- **Twitter/X** — Follow [@nosana_ai](https://x.com/nosana_ai) and [@elizaos](https://x.com/elizaos) for updates
- **GitHub** — Open an issue in this repo if you find problems with the template

---

## License

This template is open source and available under the [MIT License](./LICENSE).

---

**Built with ElizaOS · Deployed on Nosana · Powered by Qwen3.5**
