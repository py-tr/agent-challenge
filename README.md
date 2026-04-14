# Pulse — Personal AI Chief of Staff

> Reads your inbox. Guards your commitments. Proposes every action. You approve or reject — nothing executes automatically.

![ElizaOS](./assets/NosanaXEliza.jpg)

**[Nosana × ElizaOS Agent Challenge 2026](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/) · Branch: `elizaos-challenge` · Docker: `pytrdev/pulse-agent:latest`**

---

## By the Numbers

| | |
|---|---|
| **92 tests** across 8 files — in-memory PGLite, zero mocks | **6 ElizaOS Actions** dispatched by the LLM |
| **5 ElizaOS Services** running autonomously | **3 ElizaOS Providers** injecting context into every prompt |
| **2 ElizaOS Evaluators** (one `alwaysRun: true`) | **Real Gmail + Google Calendar** — not simulated |
| **Nosana GPU inference** for all LLM calls | **Docker** — single container, cold-start safe |

---

## Demo

🎥 **[Watch demo video →](https://www.youtube.com/watch?v=r3P97mGwUJc)**

**Full flow in 4 steps:**
1. Email arrives in Gmail → Pulse classifies it and drafts a reply
2. Calendar conflict detected → Pulse proposes a resolution
3. You wrote *"I'll send this by Friday"* → Slib Guard creates a reminder
4. You approve/reject each item with one click — nothing was auto-sent

---

## The Problem

Knowledge workers spend ~2.5 hours/day on email. The real cost isn't reading — it's deciding: *Does this need a reply? Did I forget that commitment? Am I double-booked?*

Pulse runs autonomously on a Nosana GPU node and makes those decisions for you — then waits for your approval before doing anything. It's the difference between a tool that acts *on* you and one that acts *for* you.

---

## What Pulse Does

| Feature | Description |
|---------|-------------|
| **Email Triage** | Fetches Gmail, classifies each message (action-required / commitment / noise), and drafts a reply scaffold. Only actionable emails enter the queue. |
| **Slib Guard** | Scans every *outgoing* email for commitment language — *"I'll send this by Friday"*, *"Let's sync next week"*. Logs a reminder 24h before the deadline. You promised it; Pulse remembers it. |
| **Calendar Conflict Detection** | Finds overlapping events in the next 14 days. Proposes which one to reschedule and suggests free slots. |
| **Approval Queue** | Every proposed action — email reply, calendar reschedule, follow-up nudge — sits in queue until you explicitly approved. Nothing auto-executes. |
| **Decision Memory** | Every approve/reject is stored. After 10+ decisions, Pulse surfaces patterns: *"You approve 87% of email drafts, reject 60% of reschedule requests."* |
| **Follow-Up Detection** | Scans your SENT folder for emails with no reply. Creates follow-up queue items so nothing falls through the cracks. |
| **Morning Briefing** | On startup, posts a prioritized summary of pending items, today's calendar, and due commitments. |
| **Meeting Prep** | *"Prepare me for the Q2 review"* — Pulse finds the event, pulls recent email threads with attendees, and generates a bullet-point prep brief from real data. |
| **Calendar Q&A** | *"What's on my calendar this week?"* — fetches real events and injects them into the LLM prompt. No hallucinated schedules. |
| **Weather** | *"Which day has the best weather for golf this week?"* — routes to wttr.in, no API key required. |
| **PDF Analysis** | Upload any PDF in chat. Pulse extracts text, runs structured LLM analysis (summary, action items, risks), and injects doc context into follow-up questions. |
| **Draft Style Memory** | The last 10 emails you actually sent are stored and injected as style examples — Pulse learns to write like you over time. |
| **Inbox Health Score** | 0–100 score (SVG ring in sidebar) based on decisiveness, queue depth, and commitment reliability. Green / amber / red. |
| **Analytics** | 7-day bar chart (approved vs rejected), per-type approval rates, and pattern summary after 10+ decisions. |
| **Focus Mode** | One item at a time, full-screen. Keyboard shortcuts: `A` approve · `R` reject · `J`/`K` navigate. |
| **Google OAuth Relay** | Static relay on GitHub Pages handles the OAuth redirect so any Pulse deployment (local or Nosana dynamic URL) works with a single pre-registered URI. |

---

## How It Works

```
Gmail ──► GmailMcpService ──► emailClassifier (LLM) ──► action_items table
                                                              │
Google Calendar ──► CalendarMcpService ──► conflictDetector ──┘
                                                              │
                                                    Approval Queue (React UI)
                                                              │
                                          User: Approve ──► Gmail send / Calendar update
                                          User: Reject  ──► logged to decisions table
```

**Background cycle runs every 6 hours automatically:**
- Fetch new Gmail messages via History API (incremental, cursor-based)
- Classify each message with the Qwen LLM
- Scan next 14 days of calendar for conflicts
- Fire Slib Guard reminders for due commitments
- Update inbox health score

**Manual triggers available:** *"Check my emails"*, *"Scan for conflicts"*, Sync Now button.

---

## Quick Start

### Option 1 — Demo mode (no credentials required)

```bash
git clone https://github.com/py-tr/agent-challenge
cd agent-challenge && git checkout elizaos-challenge
cp .env.example .env
pnpm install && pnpm dev
```

Open `http://localhost:5173`. Pulse auto-seeds a full demo dataset — inbox queue, calendar conflicts, Slib Guard reminders, 7 days of analytics. Everything is fully interactive without any Google account.

### Option 2 — With your own Gmail + Google Calendar

#### Step 1 · Create Google OAuth credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth 2.0 Client ID** → Application type: **Web application**
3. Under **Authorized redirect URIs**, add:
   ```
   https://py-tr.github.io/agent-challenge/oauth-relay.html
   ```
4. Enable the following APIs (**APIs & Services → Library**):
   - Gmail API
   - Google Calendar API
5. Download the credentials JSON — you need `client_id` and `client_secret`

#### Step 2 · Configure and run

Add to your `.env`:
```env
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```

Start the agent:
```bash
pnpm dev
```

Open `http://localhost:3000/pulse/dashboard` → click **Sign in with Google** → authorize the requested scopes → you're connected.

> **Note:** `GOOGLE_REFRESH_TOKEN` is obtained automatically via the OAuth flow in the dashboard. You do not need to set it manually.

| Scenario | Behaviour |
|----------|-----------|
| No `GOOGLE_REFRESH_TOKEN` in env | Demo data auto-seeded on first boot |
| `PULSE_SEED_ON_START=true` | Force seed even with credentials |
| `PULSE_SEED_ON_START=false` | Never seed — real data only |
| `GOOGLE_REFRESH_TOKEN` set | Real Gmail + Calendar, no seed |

---

## Deploy on Nosana

### Using the Nosana dashboard (recommended)

1. Go to [app.nosana.com](https://app.nosana.com) → **Jobs → Post Job**
2. Copy the contents of `nos_job_def/nosana_eliza_job_definition.json`
3. Paste it into the job definition editor (replacing the template)
4. Fill in your credentials in the JSON:
   ```json
   "GOOGLE_CLIENT_ID": "your_client_id",
   "GOOGLE_CLIENT_SECRET": "your_client_secret",
   "USER_NAME": "Your Name"
   ```
5. Select **GPU market** — recommended: RTX 3090 (24 GB VRAM, sufficient for qwen2.5:14b)
6. Click **Deploy**
7. Once the job starts, open the node URL → `/pulse/dashboard`
8. Click **Sign in with Google** to connect your Gmail

> **OAuth relay:** The dashboard login uses a static GitHub Pages relay (`py-tr.github.io/agent-challenge/oauth-relay.html`) so the Nosana node's dynamic URL works with Google's pre-registered redirect URI. Add this URL to your OAuth client's authorized redirect URIs (see Step 1 above).

### Using nosana-cli

```bash
nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-3090 \
  --timeout 3600
```

### Job definition fields

| Field | Value | Notes |
|-------|-------|-------|
| `OLLAMA_MODEL` | `qwen2.5:14b` | Pulled on first boot, cached in `/var/ollama/models` |
| `SKIP_OLLAMA` | `false` | `true` routes all inference to `OPENAI_API_URL` directly |
| `OPENAI_API_URL` | Nosana endpoint | Optional fallback if Ollama is unavailable |
| `PULSE_SEED_ON_START` | `true` | Set `false` when using real Gmail credentials |
| `USER_NAME` | Your name | Personalises the morning briefing |

---

## ElizaOS Integration

Pulse is a full ElizaOS plugin — every major framework abstraction is used: Services, Actions, Providers, Evaluators, Task Workers, custom Model Handlers, and the Service Registry. The background processing loop runs autonomously through the ElizaOS task system — no user prompt required.

```
src/pulse/
├── index.ts                        # Plugin barrel: assembles all pieces + custom model handler
├── services/
│   ├── PulseBackgroundService.ts   # Service: 6-hour autonomous processing loop
│   ├── GmailMcpService.ts          # Service: Gmail client + 30-min token refresh heartbeat
│   ├── CalendarMcpService.ts       # Service: Calendar client with response caching
│   ├── MorningBriefingService.ts   # Service: startup briefing posted to chat
│   └── DailySummaryService.ts      # Service: evening decision-pattern summary
├── evaluators/
│   ├── SlibGuardEvaluator.ts       # Evaluator (alwaysRun: true): commitment detection on every message
│   └── WeatherContextEvaluator.ts  # Evaluator: caches weather data for follow-up questions
├── providers/
│   ├── ActionQueueProvider.ts      # Provider: injects pending queue into every LLM prompt
│   ├── DecisionHistoryProvider.ts  # Provider: last 10 decisions + approval-rate patterns
│   └── WebSearchProvider.ts        # Provider: real-time web data injection before generation
├── actions/
│   ├── ProcessEmailsAction.ts      # Action: trigger Gmail fetch + classify cycle
│   ├── DetectConflictsAction.ts    # Action: trigger calendar conflict scan
│   ├── DetectFollowUpsAction.ts    # Action: scan SENT folder for no-reply threads
│   ├── MeetingPrepAction.ts        # Action: generate meeting prep brief
│   ├── WebSearchAction.ts          # Action: DuckDuckGo + wttr.in
│   └── CreateCalendarEventAction.ts # Action: create Google Calendar events via chat
├── routes/
│   └── pulseRoutes.ts              # REST API: queue, approve, reject, status, analytics
├── lib/
│   └── llmFallback.ts              # Inference: Ollama (primary) → Nosana endpoint (fallback)
└── db/
    ├── schema.ts                   # Drizzle ORM table definitions (PGLite)
    ├── migrations.ts               # IF NOT EXISTS migrations — safe on cold Nosana boot
    └── queries.ts                  # Typed CRUD — no raw SQL
```

**Registration summary:**
- **5 Services** — autonomous background processing, email, calendar, briefing, summary
- **3 Providers** — queue state, decision history, and live web data injected into every prompt
- **2 Evaluators** — SlibGuard (`alwaysRun: true`) + WeatherContext
- **6 Actions** — email processing, conflict detection, follow-up detection, meeting prep, web search, calendar creation
- **Custom model handler** (`priority: 1`) — overrides `plugin-openai` to POST to `/v1/chat/completions` instead of `/v1/responses`, making Pulse work on every Nosana node

---

## Nosana Integration

### Deployment Architecture

```
Nosana GPU Node
├── Ollama :11434 (qwen2.5:14b, GPU-accelerated)   ← primary inference
└── ElizaOS Agent :3000                             ← serves frontend + API
    └── llmFallback.ts: Ollama → Nosana endpoint fallback
```

All LLM inference (email classification, draft generation, chat, meeting prep) runs on the Nosana GPU. The Docker image is based on `ollama/ollama:latest` with Node.js installed on top — Ollama has full CUDA support out of the box.

### Custom Chat Completions Handler

`plugin-openai` v2 defaults to `/v1/responses` — an API surface Nosana nodes don't expose. Pulse registers its own model handlers at `priority: 1` that POST directly to `/v1/chat/completions`:

```typescript
models: {
  [ModelType.TEXT_SMALL]: async (runtime, params) => callChatCompletions(runtime, model, params),
  [ModelType.TEXT_LARGE]: async (runtime, params) => callChatCompletions(runtime, model, params),
}
```

This makes Pulse work on **any Nosana node** without modification.

### `SKIP_OLLAMA=true` Mode

Routes all inference directly to `OPENAI_API_URL` — useful when deploying to a market where a hosted model is already available, avoiding the model pull overhead.

### GPU Metrics

Every inference call is tracked. The sidebar panel shows live stats:

```json
{
  "isNosanaNode": true,
  "llmCallCount": 47,
  "avgLatencyMs": 812,
  "tokensPerSec": 94.3,
  "modelName": "qwen2.5:14b",
  "uptimeMs": 86400000
}
```

`avgLatencyMs` is an exponential moving average (α = 0.2) computed from wall-clock inference durations.

---

## Environment Variables

**Inference**

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_MODEL` | `qwen2.5:14b` | Model served by local Ollama |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama API base |
| `SKIP_OLLAMA` | `false` | Route all inference to `OPENAI_API_URL` directly |
| `OPENAI_API_KEY` | — | API key for fallback endpoint (`nosana` for Nosana nodes) |
| `OPENAI_API_URL` | — | Fallback endpoint, e.g. `https://<node>.nos.ci/v1` |
| `OPENAI_SMALL_MODEL` | `qwen2.5:14b` | Model name at fallback endpoint |
| `OPENAI_LARGE_MODEL` | `qwen2.5:14b` | Model name at fallback endpoint |

**Google / Auth**

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth client ID — enables Sign in with Google |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token — skips OAuth flow on boot |
| `PULSE_PUBLIC_URL` | Public base URL override for OAuth redirect (auto-detected from request headers if unset) |

**General**

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3000` | Backend port |
| `USER_NAME` | — | Displayed in briefings and personalisation |
| `PULSE_JOB_TYPE` | — | `morning` or `evening` — logged in GPU metrics |
| `PULSE_SEED_ON_START` | — | `true` / `false` / unset |
| `EMBEDDING_PROVIDER` | — | Set to `none` — embeddings not used |

---

## Docker

```bash
docker build -t pytrdev/pulse-agent:latest .
docker run --gpus all -p 3000:3000 --env-file .env pytrdev/pulse-agent:latest
```

The image is based on `ollama/ollama:latest` (full CUDA support) with Node.js 23 installed on top. Frontend is compiled into `/srv/pulse-frontend/` at build time — no separate container needed. The Nosana `/app` volume mount doesn't interfere with either the frontend or the Ollama model cache.

---

## Tests

```bash
pnpm test
```

**Integration test script** (requires agent running on `:3000`):

```bash
bash test_pulse.sh
```

**92 tests across 8 files** — all using in-memory PGLite, zero external dependencies, zero mocks. Every core pipeline is covered: commitment extraction, email classification, conflict detection, DB persistence, prompt sanitization, and Nosana metrics.

```
slibGuard.test.ts          18 tests  commitment extraction + deadline timing
actionQueue.test.ts         8 tests  approve/reject + status persistence
emailClassifier.test.ts     6 tests  LLM categorization + priority assignment
conflictDetector.test.ts    7 tests  overlap detection + resolution proposals
providers.test.ts           6 tests  provider output format + context injection
persistence.test.ts         2 tests  DB migrations + CRUD round-trips
routeHelpers.test.ts       24 tests  sanitizeForPrompt, isValidEmail, recordSentDraft
nosanaMetrics.test.ts      21 tests  inference counter, EMA latency, formatUptime
```

---

## Architecture

```
┌──────────────────────────── Nosana GPU Node ──────────────────────────────┐
│                                                                            │
│  ┌── Ollama :11434 ─────────────────┐                                     │
│  │  qwen2.5:14b (GPU-accelerated)   │◄── llmFallback.ts (primary)         │
│  └──────────────────────────────────┘                                     │
│                                                                            │
│  ┌──────────────────── ElizaOS Runtime ──────────────────────────────┐    │
│  │                                                                    │    │
│  │  Services              Providers            Evaluators             │    │
│  │  ─────────             ─────────            ──────────             │    │
│  │  PulseBackground  ──►  ActionQueue    ──►   SlibGuard (alwaysRun)  │    │
│  │  GmailMcp         ──►  DecisionHistory      WeatherContext         │    │
│  │  CalendarMcp      ──►  WebSearch                                   │    │
│  │  MorningBriefing                                                   │    │
│  │  DailySummary                                                      │    │
│  │                                                                    │    │
│  │  Actions                Routes               DB (PGLite)           │    │
│  │  ───────                ──────               ───────────           │    │
│  │  ProcessEmails          /pulse/queue         action_items          │    │
│  │  DetectConflicts        /pulse/approve       commitments           │    │
│  │  DetectFollowUps        /pulse/reject        decisions             │    │
│  │  MeetingPrep            /pulse/status                              │    │
│  │  WebSearch              /pulse/analytics                           │    │
│  │  CreateCalendarEvent    /pulse/briefing                            │    │
│  └──────────────────────────────────────────────┬─────────────────────┘    │
│                                                 │ :3000                    │
└─────────────────────────────────────────────────┼────────────────────────┘
                                                  │
                                         ┌────────▼────────┐
                                         │  React + Vite   │
                                         │  Dashboard      │
                                         │  :5173 / :3000  │
                                         └─────────────────┘
```

---

## Key Design Decisions

**No auto-send.** The approval queue is the product. Every action Pulse proposes sits in queue until explicitly approved — email drafts, calendar reschedules, follow-up nudges. This makes Pulse safe by design.

**Autonomous background loop.** `PulseBackgroundService` runs every 6 hours without any user prompt — fetches Gmail via incremental History API, scans calendar, fires reminders. This is the "agent" part: it acts on your behalf while you're away.

**PGLite over PostgreSQL.** No external database. Schema managed with Drizzle ORM, `IF NOT EXISTS` migrations on every boot. Works from a clean cold start on any Nosana node.

**MCP-first, REST fallback.** `gmailClient.ts` tries Gmail MCP first; falls back to direct REST calls. Callers see an identical interface regardless of which path succeeded.

**Providers over action callbacks.** `WebSearchProvider` fetches live data and injects it into the LLM prompt *before* generation — the model has real data when it starts composing, not after.

**`ollama/ollama` base image.** The Docker image is based on the official Ollama image rather than a generic Linux base, ensuring the full CUDA stack (runner libs, CUDA backends) is present and GPU inference works on Nosana nodes without manual library configuration.

---

**Pulse · ElizaOS Plugin · Deployed on Nosana · qwen2.5:14b**
