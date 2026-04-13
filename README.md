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
| **Real-Time Web Search** | `WebSearchProvider` injects live web data into LLM context *before* generation. Only activates when you explicitly ask to search — e.g. "search for X" or "look up Y online". Routes weather to wttr.in, general queries to DuckDuckGo. |
| **Smart Reply Suggestions** | Three LLM-generated reply pills appear on every email card. One click pre-fills the draft drawer — then edit and send. Keyword fallback works even when LLM is unavailable. |
| **Pulse Score** | 0–100 inbox health score rendered as an SVG ring in the sidebar. Formula: decisiveness × 40 + queue clarity × 35 + commitment reliability × 25. Green above 70, amber 40–70, red below 40. |
| **PDF Upload + Attachment** | Attach any PDF in the chat. Pulse extracts the text server-side, runs a structured LLM analysis (summary, action items, deadlines, risks), and injects doc context into follow-up questions. Say "send the summary to x@y.com" — an LLM intent classifier detects the request and drafts the email automatically. |
| **Draft Style Memory** | The last 10 emails you actually sent are stored in memory. `/draft-assist` injects them as style examples — over time Pulse learns to write drafts that sound like you. |
| **Calendar Q&A** | Ask "what's on my calendar this week?" — Pulse fetches real events via the `/pulse/calendar-context` route and injects them into the LLM prompt before generation. No hallucinated schedules. |
| **Google OAuth Relay** | A static relay on GitHub Pages (`py-tr.github.io/agent-challenge/oauth-relay.html`) handles the OAuth redirect so any Pulse deployment (local or Nosana) can use a single registered redirect URI. |
| **Morning Briefing + Voice** | On startup, Pulse posts a prioritized briefing of pending queue items. Hit "Listen" to hear it read aloud via the Web Speech API. |
| **Follow-Up Detection** | Scans your SENT folder for emails with no reply in 3+ days. Creates follow_up queue items so nothing slips through. |
| **Meeting Prep** | `"prepare me for the Q2 review"` — Pulse finds the event, pulls recent email threads with attendees, and generates a 5-8 bullet prep brief. Uses real calendar data — not hallucinated. |
| **AI Email Summaries** | Every email draft card auto-fetches a 1-2 sentence AI summary. No clicking into the thread — the key ask is surfaced immediately. |
| **Analytics** | 7-day bar chart (approved vs rejected), per-type approval rates, and summary cards. Visualizes your decision patterns over time. |
| **Focus Mode** | One item at a time, full-screen. Keyboard-friendly: approve / reject / dismiss. Zero distraction when inbox is overwhelming. |

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
│   ├── MorningBriefingService.ts   # Service: startup briefing posted to chat
│   └── DailySummaryService.ts      # Service: evening decision-pattern summary
├── evaluators/
│   ├── SlibGuardEvaluator.ts       # Evaluator (alwaysRun: true): scans every message for commitments
│   └── WeatherContextEvaluator.ts  # Evaluator: caches weather data so follow-ups skip re-search
├── providers/
│   ├── ActionQueueProvider.ts      # Provider: injects pending queue into every LLM prompt
│   ├── DecisionHistoryProvider.ts  # Provider: last 10 decisions + approval-rate patterns
│   └── WebSearchProvider.ts        # Provider: real-time web data injection before generation
├── actions/
│   ├── ProcessEmailsAction.ts      # Action: manually trigger Gmail processing
│   ├── DetectConflictsAction.ts    # Action: manually trigger calendar scan
│   ├── DetectFollowUpsAction.ts    # Action: scan SENT folder for no-reply threads
│   ├── MeetingPrepAction.ts        # Action: generate meeting prep brief from Calendar + Gmail
│   ├── WebSearchAction.ts          # Action: DuckDuckGo + wttr.in, no API key required
│   └── CreateCalendarEventAction.ts # Action: create Google Calendar events via chat
├── routes/
│   └── pulseRoutes.ts              # Routes: REST API (/pulse/queue, approve, reject, status)
├── lib/
│   └── llmFallback.ts              # Inference fallback: Ollama (primary) → Nosana endpoint
└── db/
    ├── schema.ts                   # Drizzle ORM table definitions (PGLite)
    ├── migrations.ts               # IF NOT EXISTS migrations — safe on cold Nosana boot
    └── queries.ts                  # Typed CRUD — no raw SQL anywhere
```

**Plugin registration highlights:**

- **5 Services** — `GmailMcpService`, `CalendarMcpService`, `PulseBackgroundService`, `MorningBriefingService`, `DailySummaryService`
- **3 Providers** — `ActionQueueProvider`, `DecisionHistoryProvider`, `WebSearchProvider` — queue state, decision history, and live web data injected into every prompt
- **2 Evaluators** — `SlibGuardEvaluator` (alwaysRun: true, commitment detection) + `WeatherContextEvaluator` (caches weather data for follow-up questions without re-searching)
- **6 Actions** — `ProcessEmailsAction`, `DetectConflictsAction`, `DetectFollowUpsAction`, `MeetingPrepAction`, `WebSearchAction`, `CreateCalendarEventAction`
- **REST Routes** — full CRUD API for the React dashboard, plus direct LLM endpoints (`/pulse/draft-assist`, `/pulse/classify-intent`, `/pulse/upload`) that bypass ElizaOS session overhead for latency-sensitive operations
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
    "avgLatencyMs": 812,
    "tokensPerSec": 94.3,
    "totalTokensEstimated": 12400,
    "estimatedCostUsd": 0.0004,
    "uptimeMs": 86400000,
    "jobType": "morning",
    "modelName": "qwen2.5:14b"
  }
}
```

The sidebar GPU panel renders the model name, inference count, average latency, uptime, and job type. `avgLatencyMs` is an exponential moving average (α = 0.2) computed from wall-clock durations of each inference call.

### Local-First Inference (Ollama)

Pulse runs a local Ollama instance inside the container as the **primary** inference backend, with the Nosana-hosted endpoint as a fallback.

```
Ollama (local, GPU-accelerated)  →  Nosana endpoint (fallback)
```

The fallback chain is implemented in `src/pulse/lib/llmFallback.ts` and wraps every `runtime.useModel()` call across the plugin.

**`SKIP_OLLAMA=true`** — set this to skip Ollama entirely and route all inference directly to `OPENAI_API_URL`. Useful when deploying to a market where the model is already a required resource on every node, giving instant availability without a pull.

### Deployment

Two Nosana job definitions in `nos_job_def/` — morning (6am) and evening (9pm) processing runs, both using `pytrdev/pulse-agent:latest`.

```bash
nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-4070 \
  --timeout 60
```

On first boot, the container starts Ollama, pulls `qwen2.5:14b` (~9GB), then launches the agent. The health check `start-period` is set to 300s to accommodate this. Subsequent starts on the same node are near-instant if the node has cached the model (24h cache lifetime per Nosana's caching policy).

**Tip:** Check if your target market has `qwen2.5:14b` as a required resource — if it does, the pull is instant on any node in that market:
```
https://dashboard.k8s.prd.nos.ci/api/markets/<Market-Address>/required-resources
```

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/py-tr/agent-challenge
cd agent-challenge && git checkout elizaos-challenge
cp .env.example .env   # fill in credentials — see table below
pnpm install

# Run agent (backend on :3000) + frontend (HMR on :5173)
pnpm dev:hot

# Or: backend only (frontend built into /dist-frontend and served by agent)
pnpm dev
```

Open `http://localhost:5173` — the dashboard connects automatically.

### Try it without Google credentials

No Gmail or Calendar setup? No problem. If `GOOGLE_REFRESH_TOKEN` is not set, Pulse automatically seeds the dashboard with realistic demo data on first boot — a full inbox queue, calendar conflicts, Slib Guard reminders, and 7 days of analytics history. Everything is fully interactive: approve items, reject them, chat with the agent, try meeting prep — all without connecting a real account.

| Scenario | What happens |
|----------|-------------|
| No `GOOGLE_REFRESH_TOKEN` | Demo data seeded automatically — dashboard is populated on first launch |
| `PULSE_SEED_ON_START=true` | Force demo seed even when credentials are present (useful for testing) |
| `PULSE_SEED_ON_START=false` | Never seed — start with an empty dashboard regardless |
| `GOOGLE_REFRESH_TOKEN` set | Real Gmail + Calendar data only, no seeding |

Demo data is only inserted when the queue is empty, so it never overwrites real items.

---

## Environment Variables

**Inference** (Ollama is primary; `OPENAI_*` used as fallback or when `SKIP_OLLAMA=true`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_MODEL` | `qwen2.5:14b` | Model pulled and served by local Ollama |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama API base URL |
| `SKIP_OLLAMA` | `false` | Set `true` to skip Ollama and route all inference to `OPENAI_API_URL` |
| `OPENAI_API_KEY` | — | Inference API key for fallback endpoint (`nosana` for Nosana nodes) |
| `OPENAI_API_URL` | — | Fallback inference endpoint, e.g. `https://<node>.nos.ci/v1` |
| `OPENAI_SMALL_MODEL` | `qwen2.5:14b` | Model name for fallback endpoint |
| `OPENAI_LARGE_MODEL` | `qwen2.5:14b` | Model name for fallback endpoint |

**Google / Auth**

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID — enables "Sign in with Google" button |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | — | Long-lived refresh token — set directly to skip the OAuth flow |
| `PULSE_PUBLIC_URL` | — | Public base URL for OAuth redirect (e.g. `https://your-node.nos.ci`) |

**General**

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3000` | Backend port |
| `PULSE_JOB_TYPE` | — | `morning` or `evening` — logged in metrics, used by Nosana job definitions |
| `PULSE_SEED_ON_START` | — | `true` = always seed demo data; `false` = never seed; unset = seed only when no Google credentials |
| `EMBEDDING_PROVIDER` | — | Set to `none` — embeddings not required by Pulse |

### Google Authentication

Pulse supports two ways to connect Google:

1. **"Sign in with Google" button** — works on any deployment (local or Nosana) via a static OAuth relay hosted on GitHub Pages. Register **one** redirect URI in Google Cloud Console and it works everywhere:
   ```
   https://py-tr.github.io/agent-challenge/oauth-relay.html
   ```
   The relay receives the Google callback and forwards the auth code back to whichever Pulse instance started the flow (encoded in the OAuth `state` parameter).

2. **`GOOGLE_REFRESH_TOKEN` env var** — set directly in `.env` or the Nosana job definition. Takes priority over the OAuth flow. Useful for headless/automated deployments.

**One-time Google Cloud setup:**
- Create an OAuth 2.0 Client ID at [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials
- Add authorized redirect URI: `https://py-tr.github.io/agent-challenge/oauth-relay.html`
- Enable Gmail API + Google Calendar API
- Copy Client ID + Secret into `.env`

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

92 tests across 8 files — all using in-memory PGLite, no external dependencies, no mocked database:

```
src/pulse/tests/slibGuard.test.ts         18 tests  commitment extraction + deadline timing
src/pulse/tests/actionQueue.test.ts        8 tests  approve/reject + status persistence
src/pulse/tests/emailClassifier.test.ts    6 tests  LLM categorization + priority assignment
src/pulse/tests/conflictDetector.test.ts   7 tests  overlap detection + resolution proposals
src/pulse/tests/providers.test.ts          6 tests  provider output format + context injection
src/pulse/tests/persistence.test.ts        2 tests  DB migrations + CRUD round-trips
src/pulse/tests/routeHelpers.test.ts      24 tests  sanitizeForPrompt, isValidEmail, recordSentDraft
src/pulse/tests/nosanaMetrics.test.ts     21 tests  inference counter, EMA latency, formatUptime, security
```

---

## Architecture Diagram

```
┌──────────────────────────────── Nosana GPU Node ─────────────────────────────────┐
│                                                                                   │
│  ┌── Ollama :11434 ──────────────────┐                                           │
│  │  qwen2.5:14b (GPU-accelerated)    │◄── llmFallback.ts (primary)               │
│  └───────────────────────────────────┘                                           │
│                                                                                   │
│  ┌─────────────────────────── ElizaOS Runtime ───────────────────────────────┐   │
│  │                                                                            │   │
│  │   Services              Providers              Evaluators                  │   │
│  │   ─────────             ─────────              ──────────                  │   │
│  │   PulseBackground  →    ActionQueue     →    SlibGuard (alwaysRun)         │   │
│  │   GmailMcp         →    DecisionHistory      WeatherContext                │   │
│  │   CalendarMcp      →    WebSearch                                          │   │
│  │   MorningBriefing                                                          │   │
│  │   DailySummary                                                             │   │
│  │                                                                            │   │
│  │   Actions                Routes                DB                          │   │
│  │   ───────                ──────                ──                          │   │
│  │   ProcessEmails          /pulse/queue          PGLite                      │   │
│  │   DetectConflicts        /pulse/approve        action_items                │   │
│  │   DetectFollowUps        /pulse/reject         commitments                 │   │
│  │   MeetingPrep            /pulse/status         decisions                   │   │
│  │   WebSearch              /pulse/decisions                                  │   │
│  │   CreateCalendarEvent    /pulse/analytics                                  │   │
│  └────────────────────────────────────────────────────────────┬───────────────┘   │
│                                                               │ :3000             │
└───────────────────────────────────────────────────────────────┼───────────────────┘
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

**Ollama-first inference.** `llmFallback.ts` wraps every `runtime.useModel()` call. Ollama runs locally on the same GPU node, so inference is fast and fully under our control. The Nosana-hosted endpoint serves as a fallback — no code changes needed to switch between them.

---

**Pulse · ElizaOS Plugin · Deployed on Nosana · qwen2.5:14b**
