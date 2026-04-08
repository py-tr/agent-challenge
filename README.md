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

| Activity | Date | CTA |
|---|---|---|
| Official Announcement And Start | March 25, 12:00 UTC | [superteam.fun/earn/listing/nosana-builders-elizaos-challenge/](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/) |
| AI Builders Amsterdam Workshop | March 25, 18:00, Amsterdam | [luma.com/amsterdam-mar25](https://luma.com/amsterdam-mar25) |
| SuperTeam Live Workshop w/ David & Denis  | March 26 – 19:00 CET | [luma.com/pepmqy4k](https://luma.com/pepmqy4k) |
| Builders Challenge Singapore Workshop | Thursday, April 2, 6:00–9:00 PM GMT+8 | [luma.com/nosanachallenge](https://luma.com/nosanachallenge) |
| Eliza Workshop | Thursday, April 2, 6:00–7:00 PM GMT+2 | [luma.com/5z3zbsfz](https://luma.com/5z3zbsfz) |
| **End of Builders Challenge** | **14 April** | — |
| **Winner Announcement** | **23 April** | — |

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

## Claim Your Nosana Builders Credits

All challenge participants get **free compute credits** to deploy and run their agents on Nosana.

**How to claim:**

1. Visit [nosana.com/builders-credits](https://nosana.com/builders-credits)
2. Sign up or log in with your wallet
3. Your credits will be added to your account automatically
4. Use these credits to deploy your ElizaOS agent to the Nosana network

These credits cover the compute costs for running your agent during the challenge period.

> **Note:** Credits are airdropped twice a day. Please be patient if you don't see them immediately after signing up.

---

## Configure Your LLM

Nosana provides a hosted **Qwen3.5-27B-AWQ-4bit** endpoint for challenge participants. Update your `.env`:

```env
OPENAI_API_KEY=nosana
OPENAI_API_URL=https://3gsrmj6gchzyws9bnc835apd4fh6t5tyeppmbxmzrzhn.node.k8s.prd.nos.ci/v1
MODEL_NAME=Qwen3.5-27B-AWQ-4bit
```

**Model Details:**
- **Model ID:** `Qwen3.5-27B-AWQ-4bit`
- **Max Context Length:** 60,000 tokens
- **Provider:** Nosana decentralized inference
- **Base Model:** cyankiwi/Qwen3.5-27B-AWQ-4bit

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

## What You'll Build

Your submission should include:
- **A working AI agent** built with ElizaOS
- **A frontend interface** to interact with your agent (web UI, chat interface, dashboard, etc.)
- **Deployment on Nosana** — your agent must run on Nosana's decentralized infrastructure

**The deeper your Nosana integration, the better your score.** We're looking for projects that fully embrace decentralized infrastructure — not just a minimal deployment, but thoughtful integration into your architecture.

### Examples of Deep Integration (Better Scores):
- Using Nosana for both training and inference
- Multi-node deployments across Nosana's network
- Custom deployment pipelines using Nosana CLI
- Monitoring and observability integrated with Nosana infrastructure
- Storage solutions that leverage decentralized networks
- Creative use of Nosana's compute marketplace

---

## Submission

Submit your project via the official submission page: **[superteam.fun/earn/listing/nosana-builders-elizaos-challenge/](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/)** before **April 14, 2026**.

**Submission Checklist** — All items are required:

- [ ] **Fork this repository** and build your agent on the `elizaos-challenge` branch
- [ ] **Build a frontend/UI** for interacting with your agent
- [ ] **Deploy to Nosana** and get your public deployment URL (agent must run on Nosana infrastructure)
- [ ] **Star the following repositories:**
  - [ ] [nosana-ci/agent-challenge](https://github.com/nosana-ci/agent-challenge)
  - [ ] [nosana-ci/nosana-programs](https://github.com/nosana-ci/nosana-programs)
  - [ ] [nosana-ci/nosana-kit](https://github.com/nosana-ci/nosana-kit)
  - [ ] [nosana-ci/nosana-cli](https://github.com/nosana-ci/nosana-cli)
- [ ] **Make a social media post** about your project on your platform of choice (X/Twitter, LinkedIn, Bluesky, Instagram, or other)
- [ ] **Provide your GitHub fork link** (public repository)
- [ ] **Provide your Nosana deployment URL** (running agent)
- [ ] **Write a description** of your agent and what it does (≤300 words)
- [ ] **Record a video demo** (<1 minute) showing your agent and frontend in action

> **⚠️ Important:** Submissions that do not meet these requirements will not be considered.

> For complete submission requirements and additional information, visit the [official challenge page](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/).

---

## Judging Criteria

| Criterion | Weight |
|-----------|--------|
| Technical implementation | 25% |
| Nosana integration depth | 25% |
| Usefulness & UX | 25% |
| Creativity & originality | 15% |
| Documentation | 10% |

**Judging Details:**
- **Technical implementation (25%)** — Code quality, architecture, and ElizaOS best practices
- **Nosana integration depth (25%)** — How deeply Nosana is integrated into your deployment and infrastructure
- **Usefulness & UX (25%)** — Real-world applicability, frontend quality, and user experience
- **Creativity & originality (15%)** — Innovative use cases and novel approaches
- **Documentation (10%)** — Code quality, README, setup instructions

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
