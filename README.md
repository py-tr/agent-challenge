# Pulse — Autonomous Chief of Staff

> Reads your inbox. Guards your commitments. Runs on Nosana GPU. Nothing leaves without your approval.

![ElizaOS](./assets/NosanaXEliza.jpg)

**[Nosana × ElizaOS Agent Challenge 2026](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/) · Branch: `elizaos-challenge` · Docker: `pytrdev/pulse-agent:latest`**

---

## The Problem

Email is where good intentions go to die. You write "I'll have this to you by Friday" — and Friday arrives without a trace. You accept two meetings at the same time without noticing. Important threads get buried under newsletters.

Pulse runs on a Nosana GPU node, processes your Gmail and Google Calendar on a schedule, and builds a prioritized action queue. You open the dashboard and make decisions with one click. Nothing is auto-sent — that's a feature, not a limitation.

---

## What Makes Pulse Different

| Feature | What it does |
|---------|-------------|
| **Slib Guard** | Scans every outgoing message for commitment language — *"I'll send this by Friday"*, *"Let's sync next week"*. Creates a reminder 24h before the deadline. You promised it; Pulse remembers it. |
| **Decision Memory** | Every approve/reject is stored. After 10+ decisions, Pulse surfaces your patterns: *"You approve 87% of email drafts, reject 60% of reschedule suggestions."* |
| **Approval Queue** | Every proposed action sits in queue until you explicitly approve it. Email drafts, calendar reschedules, follow-up reminders — nothing executes automatically. |
| **Calendar Conflict Detection** | Finds overlapping events. Proposes a resolution. You pick which one moves. |
| **Real-Time Web Search** | `WebSearchProvider` injects live weather and factual data into LLM context *before* generation — no hallucination, no fabricated forecasts. Routes weather to wttr.in, general queries to DuckDuckGo. |
| **Morning Briefing** | On startup, Pulse posts a prioritized briefing of pending queue items to the chat. P1 first, everything else ranked below. |

---

## ElizaOS Integration

Pulse uses every major ElizaOS abstraction — this is a full plugin implementation, not a wrapper.

```
src/pulse/
├── index.ts                        # Plugin barrel: assembles all pieces + custom model handler
├── services/
│   ├── PulseBackgroundService.ts   # Service: 6-hour processing loop (Gmail + Calendar)
│   ├── GmailMcpService.ts          # Service: MCP client + 30-min token refresh heartbeat
│   ├── CalendarMcpService.ts       # Service: Calendar MCP wrapper with response caching
│   └── MorningBriefingService.ts   # Service: startup briefing posted to chat
├── evaluators/
│   └── SlibGuardEvaluator.ts       # Evaluator (alwaysRun: true): scans every message
├── providers/
│   ├── ActionQueueProvider.ts      # Provider: injects pending queue into every LLM prompt
│   ├── DecisionHistoryProvider.ts  # Provider: last 10 decisions + approval-rate patterns
│   └── WebSearchProvider.ts        # Provider: real-time web data injection before generation
├── actions/
│   ├── ProcessEmailsAction.ts      # Action: manually trigger Gmail processing
│   ├── DetectConflictsAction.ts    # Action: manually trigger calendar scan
│   └── WebSearchAction.ts          # Action: DuckDuckGo + wttr.in, no API key required
├── routes/
│   └── pulseRoutes.ts              # Routes: REST API (/pulse/queue, approve, reject, status)
└── db/
    ├── schema.ts                   # Drizzle ORM table definitions (PGLite)
    ├── migrations.ts               # IF NOT EXISTS migrations — safe on cold Nosana boot
    └── queries.ts                  # Typed CRUD — no raw SQL anywhere
```

**Plugin registration highlights:**

- **4 Services** — background processing, MCP clients, morning briefing
- **3 Providers** — queue state, decision history, and live web data injected into every prompt
- **1 Evaluator** — `alwaysRun: true`, fires on every message to detect commitment language
- **3 Actions** — email processing, conflict detection, web search
- **REST Routes** — full CRUD API for the React dashboard
- **Custom model handler** — `priority: 1` overrides `plugin-openai` to POST directly to `/v1/chat/completions`, bypassing `@ai-sdk/openai`'s Responses API default (which Nosana nodes don't support)

---

## Nosana Integration

### Custom Chat Completions Handler

`plugin-openai` v2 routes all inference through `/v1/responses` — a newer API endpoint that Nosana's GPU nodes don't expose. Pulse registers its own `TEXT_SMALL` and `TEXT_LARGE` model handlers at `priority: 1`, which POST directly to `/v1/chat/completions`:

```typescript
// src/pulse/index.ts
models: {
  [ModelType.TEXT_SMALL]: async (runtime, params) => callChatCompletions(runtime, model, params),
  [ModelType.TEXT_LARGE]: async (runtime, params) => callChatCompletions(runtime, model, params),
}
```

This makes Pulse work on **any Nosana node** without modification — not just nodes that expose newer API surfaces.

### GPU Inference Counter

Every successful LLM call increments a persistent counter via `nosanaMetrics.ts`. The `/pulse/status` endpoint exposes:

```json
{
  "nosana": {
    "nodeId": "3gsrmj...",
    "isNosanaNode": true,
    "llmCallCount": 47,
    "uptimeMs": 86400000,
    "jobType": "morning"
  }
}
```

The dashboard StatusBar renders: *"47 inferences run on Nosana GPU · Up 24h"*

### Deployment

Two Nosana job definitions in `nos_job_def/` — morning (6am) and evening (9pm) processing runs, both using `pytrdev/pulse-agent:latest`.

```bash
nosana job post \
  --file ./nos_job_def/nosana_morning_job.json \
  --market nvidia-4090 \
  --timeout 60
```

Model: **Qwen3.5-27B-AWQ-4bit** running on Nosana GPU infrastructure.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/pytrdev/agent-challenge
cd agent-challenge && git checkout elizaos-challenge
cp .env.example .env   # fill in credentials — see table below
pnpm install

# Run agent (backend on :3000) + frontend (HMR on :5173)
pnpm dev:hot

# Or: backend only (frontend built into /dist-frontend and served by agent)
pnpm dev
```

Open `http://localhost:5173` — the dashboard connects automatically.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | `nosana` for Nosana nodes, or your OpenAI key |
| `OPENAI_API_URL` | Yes | Nosana node endpoint, e.g. `https://<node>.nos.ci/v1` |
| `OPENAI_SMALL_MODEL` | Yes | `Qwen3.5-27B-AWQ-4bit` |
| `OPENAI_LARGE_MODEL` | Yes | `Qwen3.5-27B-AWQ-4bit` |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Long-lived refresh token for Gmail + Calendar |
| `SERVER_PORT` | No | Backend port (default: `3000`) |
| `PULSE_JOB_TYPE` | No | `morning` or `evening` — controls which processing mode runs |
| `PULSE_SEED_ON_START` | No | `true` to auto-seed demo data on first boot |
| `EMBEDDING_PROVIDER` | No | Set to `none` — embeddings not used |

---

## Docker Deployment

```bash
# Build
docker build -t pytrdev/pulse-agent:latest .

# Run locally (agent + frontend served on :3000)
docker run -p 3000:3000 --env-file .env pytrdev/pulse-agent:latest

# Push to registry
docker push pytrdev/pulse-agent:latest
```

The frontend is compiled into `/srv/pulse-frontend/` at build time and served as static files by the ElizaOS HTTP server — no separate frontend container needed. The Nosana volume mount on `/app` doesn't interfere.

---

## Tests

```bash
pnpm test
```

47 tests across 6 files — all using in-memory PGLite, no external dependencies, no mocked database:

```
src/pulse/tests/slibGuard.test.ts        18 tests  commitment extraction + deadline timing
src/pulse/tests/actionQueue.test.ts       8 tests  approve/reject + status persistence
src/pulse/tests/emailClassifier.test.ts   6 tests  LLM categorization + priority assignment
src/pulse/tests/conflictDetector.test.ts  7 tests  overlap detection + resolution proposals
src/pulse/tests/providers.test.ts         6 tests  provider output format + context injection
src/pulse/tests/persistence.test.ts       2 tests  DB migrations + CRUD round-trips
```

---

## Architecture Diagram

```
┌─────────────────────────── Nosana GPU Node ────────────────────────────┐
│                                                                         │
│  ┌─────────────────────────── ElizaOS Runtime ──────────────────────┐  │
│  │                                                                   │  │
│  │   Services              Providers              Evaluator          │  │
│  │   ─────────             ─────────              ─────────          │  │
│  │   PulseBackground  →    ActionQueue     →    SlibGuard            │  │
│  │   GmailMcp         →    DecisionHistory       (alwaysRun)         │  │
│  │   CalendarMcp      →    WebSearch                                 │  │
│  │   MorningBriefing                                                 │  │
│  │                                                                   │  │
│  │   Actions                Routes                DB                 │  │
│  │   ───────                ──────                ──                 │  │
│  │   ProcessEmails          /pulse/queue          PGLite             │  │
│  │   DetectConflicts        /pulse/approve        action_items       │  │
│  │   WebSearch              /pulse/reject         commitments        │  │
│  │                          /pulse/status         decisions          │  │
│  │                          /pulse/decisions                         │  │
│  └────────────────────────────────────────────────────┬──────────────┘  │
│                                                       │ :3000           │
└───────────────────────────────────────────────────────┼─────────────────┘
                                                        │
                                               ┌────────▼────────┐
                                               │  React + Vite   │
                                               │  Dashboard      │
                                               │  :5173 / :3000  │
                                               └─────────────────┘
```

---

## Key Design Decisions

**No auto-send.** The approval queue is the product. Every action Pulse proposes sits in queue until explicitly approved. This makes Pulse trustworthy by design — it can't do damage without you.

**MCP-first, googleapis fallback.** `gmailClient.ts` tries MCP first; falls back to direct `googleapis` calls on failure. Callers see an identical interface. Works in any environment.

**Providers over action callbacks.** `WebSearchProvider` fetches live data and injects it into the LLM prompt *before* generation — not after via action callbacks. The model always has real data when it starts composing a response.

**PGLite over PostgreSQL.** No external database. Schema managed with Drizzle ORM, `IF NOT EXISTS` migrations run on every boot. Works from a clean cold start on any Nosana node.

---

**Pulse · ElizaOS Plugin · Deployed on Nosana · Qwen3.5-27B**
