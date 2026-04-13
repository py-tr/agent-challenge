/**
 * src/pulse/actions/MeetingPrepAction.ts
 * ElizaOS Action — generates a meeting preparation brief on demand.
 *
 * Flow:
 *   1. Parse person / event name from the user's message
 *   2. Fetch upcoming calendar events (next 7 days) and find the best match
 *   3. Search Gmail for recent threads with the attendees
 *   4. Ask the LLM to synthesize a concise prep brief
 *   5. Stream the brief back via callback
 *
 * Trigger phrases:
 *   "prepare me for [meeting/person]", "meeting prep [name]",
 *   "what do I need to know for [meeting]", "brief me on [name]",
 *   "prep for [event]", "getting ready for [meeting]"
 */

import type {
  Action, IAgentRuntime, Memory, State,
  HandlerCallback, ActionResult,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { CalendarMcpService } from "../services/CalendarMcpService.js";
import { searchMessages } from "../lib/gmailClient.js";
import type { CalendarEvent } from "../lib/calendarClient.js";
import { useModelWithFallback } from "../lib/llmFallback.js";

// ─── Trigger detection ────────────────────────────────────────────────────────

const PREP_RE =
  /\b(prep(?:are)?(?:\s+me)?(?:\s+for)?|brief(?:\s+me)?(?:\s+on)?|ready(?:\s+for)?|what.*know.*for|meeting\s+prep)\b/i;

function isMeetingPrepRequest(text: string): boolean {
  return PREP_RE.test(text);
}

/**
 * Extract the name/topic the user wants to prep for.
 * "prepare me for the Q2 review" → "Q2 review"
 * "brief me on Sarah" → "Sarah"
 */
function extractTopic(text: string): string {
  // Remove the trigger phrase and clean up
  const cleaned = text
    .replace(/prepare\s+me\s+for(\s+the)?/i, "")
    .replace(/prep(?:are)?\s+for(\s+the)?/i, "")
    .replace(/brief\s+me\s+on/i, "")
    .replace(/meeting\s+prep(\s+for)?(\s+the)?/i, "")
    .replace(/what\s+do\s+i\s+need\s+to\s+know\s+for(\s+the)?/i, "")
    .replace(/get(?:ting)?\s+ready\s+for(\s+the)?/i, "")
    .trim();
  return cleaned || text.trim();
}

/**
 * Find the most relevant upcoming event given a topic string.
 * Scores events by how many words from the topic appear in the title/description/attendees.
 */
function findBestMatch(events: CalendarEvent[], topic: string): CalendarEvent | null {
  if (events.length === 0) return null;

  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return events[0];

  let best: CalendarEvent | null = null;
  let bestScore = -1;

  for (const ev of events) {
    const haystack = [
      ev.title,
      ev.description ?? "",
      ...ev.attendees,
    ].join(" ").toLowerCase();

    const score = words.filter((w) => haystack.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }

  // If nothing matched at all, return the next upcoming event
  return best ?? events[0];
}

function formatEventTime(iso: string, allDay: boolean): string {
  if (allDay) return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const meetingPrepAction: Action = {
  name: "MEETING_PREP",

  description:
    "Generate a concise meeting preparation brief for an upcoming calendar event. " +
    "Fetches the event details, attendees, and recent email threads with those people, " +
    "then synthesizes talking points and context the user should know before the meeting. " +
    "Triggered when the user asks to prepare for a meeting or brief them on a person/topic.",

  similes: [
    "PREPARE_FOR_MEETING",
    "MEETING_BRIEF",
    "PREP_BRIEF",
    "BRIEF_ME",
    "PRE_MEETING_SUMMARY",
    "GET_READY_FOR_MEETING",
  ],

  examples: [
    [
      { name: "user", content: { text: "Prepare me for my meeting with Sarah" } },
      { name: "Pulse", content: { text: "Pulling your calendar and recent emails with Sarah…" } },
    ],
    [
      { name: "user", content: { text: "Meeting prep for Q2 review" } },
      { name: "Pulse", content: { text: "Generating your Q2 review brief…" } },
    ],
    [
      { name: "user", content: { text: "What do I need to know for the investor call?" } },
      { name: "Pulse", content: { text: "Looking up the investor call details…" } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text as string | undefined) ?? "";
    return isMeetingPrepRequest(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const userText = (message.content?.text as string | undefined) ?? "";
    const topic = extractTopic(userText);

    await callback?.({ text: `Looking up your calendar and recent emails for "${topic}"…` });

    try {
      // ── 1. Fetch upcoming events ──────────────────────────────────────────
      let events: CalendarEvent[] = [];
      const calSvc = runtime.getService(CalendarMcpService.serviceType) as CalendarMcpService | null;

      if (calSvc) {
        try {
          events = await calSvc.getEvents(7);
        } catch {
          // calendar unavailable — proceed without it
        }
      }

      const event = findBestMatch(events, topic);

      // ── 2. Search Gmail for recent context ────────────────────────────────
      let emailContext = "";
      try {
        // Build a search query: attendee names/emails + topic keywords
        const attendeeQuery = event?.attendees.slice(0, 3).join(" OR ") ?? topic;
        const query = attendeeQuery || topic;
        const recentEmails = await searchMessages(query, 5);

        if (recentEmails.length > 0) {
          emailContext = recentEmails
            .slice(0, 4)
            .map((m) => `- "${m.subject}" from ${m.from} (${m.date.slice(0, 16)}): ${m.snippet.slice(0, 120)}`)
            .join("\n");
        }
      } catch {
        // Gmail unavailable — proceed without email context
      }

      // ── 3. Build LLM prompt ───────────────────────────────────────────────
      const eventSection = event
        ? `MEETING: ${event.title}
Time: ${formatEventTime(event.start, event.allDay)}
${event.attendees.length > 0 ? `Attendees: ${event.attendees.join(", ")}` : ""}
${event.location ? `Location: ${event.location}` : ""}
${event.description ? `Description: ${event.description.slice(0, 300)}` : ""}`
        : `No specific calendar event found for "${topic}" in the next 7 days.`;

      const emailSection = emailContext
        ? `RECENT EMAIL CONTEXT:\n${emailContext}`
        : "No recent email threads found.";

      const prompt = `You are Pulse, an AI Chief of Staff. Generate a concise meeting preparation brief.

${eventSection}

${emailSection}

Write a focused 5–8 bullet prep brief covering:
• What this meeting is about (1-2 sentences)
• Key people and their roles
• What to bring up / open items from recent emails
• What the user should be ready to answer
• Any commitments or follow-ups relevant to this meeting

Keep it tight — no fluff. The user reads this 5 minutes before the meeting.`;

      const brief = await useModelWithFallback(runtime, ModelType.TEXT_LARGE, { prompt });

      const summary = event
        ? `Here's your prep brief for **${event.title}** (${formatEventTime(event.start, event.allDay)}):\n\n${brief}`
        : `Here's your prep brief for **${topic}**:\n\n${brief}`;

      await callback?.({ text: summary });
      return { success: true, text: summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Meeting prep failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
