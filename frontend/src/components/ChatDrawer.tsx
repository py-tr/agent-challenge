import { useState, useEffect, useRef, useCallback } from "react";
import { X, ArrowUp, Square, MessageSquare, Mail, Send, Check, ChevronDown } from "lucide-react";
import { agentApi, pulseApi, type EmailDraftContext, type ConflictContext } from "../api/pulseApi";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "agent";
  text: string;
  ts: Date;
  /** Green bubble for timeout/progress notices. */
  positive?: boolean;
  /**
   * When set, shows a "Use this draft" button below the bubble.
   * Only populated when extractDraftSuggestion() found a real email draft.
   */
  draftSuggestion?: string;
  /**
   * Marks a transient polling-indicator bubble. When polling finds the real
   * response, this bubble is removed and replaced with the actual reply.
   */
  pollingPlaceholder?: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  agentId: string | null;
  autoSendText: string | null;
  onAutoSendConsumed: () => void;
  emailDraft?: EmailDraftContext | null;
  /** Called after a successful email send — caller should refresh queue. */
  onEmailSent?: () => void;
  onQueueRefresh?: () => void;
  /** Resolved from USER_NAME env var on the server — appended to bare sign-offs. */
  userDisplayName?: string;
  /** Number of pending queue items — used to build a proactive welcome message. */
  pendingCount?: number;
  /** Title of the highest-priority pending item for the proactive welcome. */
  firstPendingTitle?: string;
  /** When opened from a conflict_resolution card — enables reschedule intercept. */
  conflictContext?: ConflictContext | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

function buildWelcomeMessage(pendingCount?: number, firstPendingTitle?: string): string {
  if (pendingCount && pendingCount > 0 && firstPendingTitle) {
    return (
      `Hi! I'm Pulse, your Chief of Staff. You have ${pendingCount} pending item${pendingCount === 1 ? "" : "s"}. ` +
      `The most urgent is: "${firstPendingTitle}". ` +
      `Want me to help you work through it?`
    );
  }
  if (pendingCount === 0) {
    return "Hi! I'm Pulse, your Chief of Staff. Your queue is clear — well done! Ask me anything or I can search the web for you.";
  }
  return "Hi! I'm Pulse, your Chief of Staff. I can see your current queue and help you decide how to handle each item. What would you like to work through?";
}

const DRAFT_WELCOME =
  "I've loaded the draft below. You can edit it directly, use the quick actions, or tell me what to change — e.g. \"make this more concise\" or \"change the tone\". Click Send Email when you're happy with it.";

const SESSION_STORAGE_KEY = "pulse_session_id";
const USER_ID_KEY = "pulse_user_id";

/** Matches "send it", "send the email", "go ahead", "ok send", "send now", "send" alone. */
const SEND_INTENT_RE = /^(send(\s+(it|the\s+email|now))?|go\s+ahead(\s+and\s+send)?|ok\s*[,]?\s*send)$/i;

const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  {
    label:  "Make concise",
    prompt: "Make concise. Rewrite the draft as a shorter email starting with Hi and ending with Best regards, wrapped in --- separators.",
  },
  {
    label:  "Make formal",
    prompt: "Make formal. Rewrite in formal tone starting with Dear [name], ending with Kind regards, wrapped in --- separators.",
  },
  {
    label:  "Rewrite from scratch",
    prompt: "Rewrite from scratch. Write a complete email draft starting with Hi [name], and ending with Best regards. Include --- separators around the draft body.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(USER_ID_KEY, id); }
  return id;
}

function getStoredSessionId(): string | null {
  try { return sessionStorage.getItem(SESSION_STORAGE_KEY); } catch { return null; }
}

function storeSessionId(id: string): void {
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, id); } catch { /* ignore */ }
}

function formatEmailDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return dateStr; }
}

/**
 * Detect whether an agent reply looks like a rewritten email draft.
 * Returns the extracted body or null — never auto-applies; caller shows a button.
 *
 * Detection order (highest priority first):
 *   1. Scaffold marker format produced by buildReplyDraft()
 *   2. "---" separator format (markdown email blocks)
 *   3. Standalone reply starting with a greeting ("Hi Mark,")
 */
function extractDraftSuggestion(reply: string): string | null {
  // Fast-path: scaffold marker produced by buildReplyDraft()
  const SCAFFOLD_MARKER = "**Suggested reply scaffold:**\n\n";
  const SCAFFOLD_END    = "\n\n---";
  if (reply.includes(SCAFFOLD_MARKER)) {
    const start = reply.indexOf(SCAFFOLD_MARKER) + SCAFFOLD_MARKER.length;
    const end   = reply.indexOf(SCAFFOLD_END, start);
    const body  = (end !== -1 ? reply.slice(start, end) : reply.slice(start)).trim();
    if (body.length > 10) return body;
  }

  // Signal-counting approach: show "Use this draft" if ≥2 of 5 email signals are present.
  // Handles Ollama responses that use partial formatting (e.g. greeting but no "---" wrapper).
  const signals = [
    /---/.test(reply),
    /\bHi\s/i.test(reply),
    /\bDear\s/i.test(reply),
    /best\s+regards/i.test(reply),
    /kind\s+regards/i.test(reply),
  ].filter(Boolean).length;

  if (signals >= 2) {
    // Try to strip prose intro (anything before the greeting line) so the textarea
    // starts cleanly at the greeting rather than including "Here's a draft:".
    const greetingIdx = reply.search(/\n(Hi\s|Dear\s|Hello\s)/i);
    if (greetingIdx !== -1) return reply.slice(greetingIdx + 1).trim();
    return reply.trim();
  }

  return null;
}

// ─── Smart Reply Suggestions ──────────────────────────────────────────────────

/** Local keyword fallback — mirrors backend; used as instant initial state. */
function keywordFallbackReplies(subject: string): string[] {
  const s = subject.toLowerCase();
  if (["meeting", "call", "reschedule", "schedule"].some((k) => s.includes(k))) {
    return ["Yes, let's meet", "Can we reschedule?", "I'll check my calendar"];
  }
  if (["proposal", "pricing", "contract", "quote"].some((k) => s.includes(k))) {
    return ["Sounds good, let's proceed", "Need more time to review", "Can we discuss on a call?"];
  }
  return ["Sounds good", "Need more time", "Let me get back to you"];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div className="mr-auto flex max-w-[80%] items-center gap-1 rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-gray-400 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

function MessageBubble({
  msg,
  onUseDraft,
}: {
  msg: ChatMessage;
  onUseDraft?: (body: string) => void;
}) {
  const isUser = msg.role === "user";
  const bubbleClass = isUser
    ? "rounded-tr-sm bg-indigo-600 text-white"
    : msg.positive
    ? "rounded-tl-sm bg-green-50 text-green-800 ring-1 ring-green-200"
    : "rounded-tl-sm bg-gray-100 text-gray-900";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${bubbleClass}`}
      >
        {msg.text}
        {/* Animated dots while polling for a response in the background */}
        {msg.pollingPlaceholder && (
          <span className="ml-2 inline-flex items-center gap-0.5 align-middle">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-green-600 animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        )}
      </div>
      {/* Only show "Use this draft" when extractDraftSuggestion found a real email body */}
      {onUseDraft && !isUser && !msg.positive && msg.draftSuggestion != null && (
        <button
          onClick={() => onUseDraft(msg.draftSuggestion!)}
          className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition-colors hover:bg-green-100 active:scale-95"
        >
          <Check size={11} />
          Use this draft
        </button>
      )}
    </div>
  );
}

function OriginalEmailSection({ draft }: { draft: EmailDraftContext }) {
  const [expanded, setExpanded] = useState(false);

  if (!draft.originalFrom && !draft.originalSnippet) return null;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
      >
        <ChevronDown
          size={10}
          className={`transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        />
        <span>{expanded ? "Hide original" : "Show original"}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-lg border border-gray-100 bg-gray-50 p-2 text-[10px] leading-relaxed text-gray-500">
          {draft.originalFrom && (
            <div className="mb-0.5">
              <span className="font-medium text-gray-600">From:</span> {draft.originalFrom}
            </div>
          )}
          <div className="mb-0.5">
            <span className="font-medium text-gray-600">Subject:</span> {draft.subject}
          </div>
          {draft.originalDate && (
            <div className="mb-1">
              <span className="font-medium text-gray-600">Date:</span>{" "}
              {formatEmailDate(draft.originalDate)}
            </div>
          )}
          <div className="border-t border-gray-100 pt-1.5">
            {draft.originalSnippet ? (
              <div className="max-h-32 overflow-y-auto whitespace-pre-wrap">
                {draft.originalSnippet}
              </div>
            ) : (
              <p className="text-[10px] italic text-gray-400">No message preview available</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface DraftBubbleProps {
  draft: EmailDraftContext;
  body: string;
  onBodyChange: (v: string) => void;
  to: string;
  onToChange: (v: string) => void;
  toError: boolean;
  toInputRef: React.RefObject<HTMLInputElement>;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  onQuickAction: (msg: string) => void;
  justUpdated: boolean;
  smartReplies: string[];
  isLoadingReplies: boolean;
}

function DraftBubble({
  draft,
  body,
  onBodyChange,
  to,
  onToChange,
  toError,
  toInputRef,
  textareaRef,
  onQuickAction,
  justUpdated,
  smartReplies,
  isLoadingReplies,
}: DraftBubbleProps) {
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-xs">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-indigo-700">
          <Mail size={12} />
          <span>Email Draft</span>
        </div>
        {justUpdated && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-green-600">
            <Check size={10} />
            Draft updated
          </span>
        )}
      </div>

      {/* Collapsible original email */}
      <OriginalEmailSection draft={draft} />

      {/* To field */}
      <div className="mb-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-medium text-gray-700">To:</span>
          <input
            ref={toInputRef}
            type="email"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            placeholder="Enter recipient email"
            className={`min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none transition-colors ${
              toError
                ? "border-red-400 bg-red-50 focus:border-red-500 ring-1 ring-red-200"
                : "border-indigo-100 bg-white focus:border-indigo-300"
            }`}
          />
        </div>
        {toError && (
          <p className="mt-0.5 text-[10px] text-red-500 pl-8">Required — enter the recipient email</p>
        )}
      </div>

      {/* Subject */}
      <div className="mb-2 text-gray-500">
        <span className="font-medium text-gray-700">Subject:</span> {draft.subject}
      </div>

      {/* Smart reply suggestion pills — skeleton while LLM fetches */}
      <div className="mb-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Quick replies</p>
      <div className="flex flex-wrap gap-1.5">
        {isLoadingReplies ? (
          // Three pulsing gray skeleton pills
          [56, 72, 64].map((w, i) => (
            <span
              key={i}
              className="animate-pulse rounded-full bg-gray-200"
              style={{ width: w, height: 22 }}
            />
          ))
        ) : (
          smartReplies.map((suggestion) => {
            const firstName =
              draft.originalFrom?.match(/^([^<]+)</)?.[1]?.trim().split(" ")[0] ??
              "there";
            return (
              <button
                key={suggestion}
                onClick={() =>
                  onBodyChange(`Hi ${firstName},\n\n${suggestion}\n\nBest,`)
                }
                className="rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-[10px] font-medium text-indigo-600 transition-colors hover:border-indigo-400 hover:bg-indigo-50 active:scale-95"
                title={`Use: "${suggestion}"`}
              >
                {suggestion}
              </button>
            );
          })
        )}
      </div>
      </div>

      {/* Editable draft — always visible, no toggle */}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Edit draft here, or use the buttons below to ask Pulse to rewrite it..."
        className={`w-full resize-none rounded-lg border p-2 text-xs leading-relaxed text-gray-800 placeholder-gray-400 transition-all duration-300 focus:outline-none focus:ring-1 ${
          justUpdated
            ? "border-green-400 bg-green-50 ring-1 ring-green-200"
            : "border-indigo-200 bg-white focus:border-indigo-400 focus:ring-indigo-200"
        }`}
        style={{ minHeight: "120px" }}
      />

      {/* Quick action pills */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => onQuickAction(action.prompt)}
            className="rounded-full border border-gray-200 px-2.5 py-1 text-[10px] text-gray-500 transition-colors hover:border-indigo-300 hover:text-indigo-600 active:scale-95"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────

/**
 * Returns true when the email context suggests a follow-up meeting is relevant.
 * Only show the calendar offer if the subject/body mentions scheduling language.
 */
function shouldOfferCalendar(subject: string, body: string): boolean {
  const text = `${subject} ${body}`.toLowerCase();
  return [
    "call", "meeting", "sync", "discuss", "review", "follow up", "follow-up",
    "schedule", "next week", "friday", "monday", "tuesday", "wednesday", "thursday",
    "hop on", "catch up", "chat", "talk", "connect", ":00",
  ].some((k) => text.includes(k));
}

/** Marker the draft-assist LLM embeds when it detects a calendar request. */
const CALENDAR_INTENT_MARKER = "[CALENDAR_INTENT]";

// ─── Calendar Follow-Up Offer ─────────────────────────────────────────────────

interface CalendarOffer {
  recipient: string;
  subject: string;
}

function CalendarOfferPanel({
  offer,
  onSchedule,
  onDecline,
}: {
  offer: CalendarOffer;
  onSchedule: (title: string, date: string, time: string) => void;
  onDecline: () => void;
}) {
  const defaultDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState(`Follow up: ${offer.subject}`);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("10:00");

  if (!showForm) {
    return (
      <div className="rounded-xl border p-3 text-xs space-y-2" style={{ borderColor: "#bfdbfe", backgroundColor: "#eff6ff" }}>
        <p className="font-medium" style={{ color: "#1e40af" }}>
          Schedule a follow-up meeting?
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm(true)}
            className="flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors active:scale-95"
            style={{ backgroundColor: "#2563eb" }}
          >
            Yes, schedule it
          </button>
          <button
            onClick={onDecline}
            className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80 active:scale-95"
            style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#2563eb" }}
          >
            No thanks
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border p-3 text-xs space-y-2" style={{ borderColor: "#bfdbfe", backgroundColor: "#eff6ff" }}>
      <p className="font-semibold" style={{ color: "#1e40af" }}>Schedule a follow-up</p>

      <div>
        <label className="mb-0.5 block text-[10px] font-medium" style={{ color: "#6b7280" }}>Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1"
          style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#1f2937" }}
        />
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="mb-0.5 block text-[10px] font-medium" style={{ color: "#6b7280" }}>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded border px-2 py-1 text-xs focus:outline-none"
            style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#1f2937" }}
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] font-medium" style={{ color: "#6b7280" }}>Time</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded border px-2 py-1 text-xs focus:outline-none"
            style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#1f2937", width: "90px" }}
          />
        </div>
      </div>

      <div className="flex gap-2 pt-0.5">
        <button
          onClick={() => onSchedule(title, date, time)}
          disabled={!title.trim() || !date || !time}
          className="flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-40 active:scale-95"
          style={{ backgroundColor: "#2563eb" }}
        >
          Add to Calendar
        </button>
        <button
          onClick={onDecline}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80 active:scale-95"
          style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#2563eb" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── ChatDrawer ───────────────────────────────────────────────────────────────

export function ChatDrawer({
  isOpen,
  onClose,
  agentId,
  autoSendText,
  onAutoSendConsumed,
  emailDraft,
  onEmailSent,
  onQueueRefresh,
  userDisplayName,
  pendingCount,
  firstPendingTitle,
  conflictContext,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(getStoredSessionId);
  const [currentDraftBody, setCurrentDraftBody] = useState<string>("");
  const [currentDraftTo, setCurrentDraftTo] = useState<string>("");
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [draftJustUpdated, setDraftJustUpdated] = useState(false);
  const [toError, setToError] = useState(false);
  const [emailSentSuccess, setEmailSentSuccess] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [smartReplies, setSmartReplies] = useState<string[]>([]);
  const [isLoadingReplies, setIsLoadingReplies] = useState(false);
  const [calendarOffer, setCalendarOffer] = useState<CalendarOffer | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const isNearBottomRef = useRef(true);
  const processedAutoSend = useRef<string | null>(null);
  const welcomeShown = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDraftItemId = useRef<string | null>(null);
  const currentDraftBodyRef = useRef<string>("");
  const currentDraftToRef = useRef<string>("");
  const emailDraftRef = useRef<EmailDraftContext | null | undefined>(null);
  const draftPrimedRef = useRef<string | null>(null);
  /** Timestamp of the last outgoing user message — used as the `after` cursor for polling. */
  const sentAtRef = useRef<Date | null>(null);
  /** Active session ID captured at send-time so the timeout handler can poll it. */
  const currentSessionIdRef = useRef<string | null>(null);
  /** setInterval handle for the polling fallback. */
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Captures the sid + after values needed inside the interval callback. */
  const pollContextRef = useRef<{ sid: string; after: Date } | null>(null);

  // Keep refs in sync
  useEffect(() => { currentDraftBodyRef.current = currentDraftBody; }, [currentDraftBody]);
  useEffect(() => { currentDraftToRef.current = currentDraftTo; }, [currentDraftTo]);
  useEffect(() => { emailDraftRef.current = emailDraft; }, [emailDraft]);

  // ── Polling helpers ──────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    pollContextRef.current = null;
    setIsPolling(false);
  }, []);

  /** Start a 5s-interval poll for up to 60s after a frontend timeout. */
  const startPolling = useCallback((sid: string, after: Date) => {
    pollContextRef.current = { sid, after };
    setIsPolling(true);
    const deadline = Date.now() + 60_000;

    pollIntervalRef.current = setInterval(() => {
      if (Date.now() >= deadline) {
        stopPolling();
        return;
      }
      const ctx = pollContextRef.current;
      if (!ctx) return;

      void agentApi.getMessages(ctx.sid, ctx.after).then((reply) => {
        if (!reply) return;
        stopPolling();
        const suggestion = emailDraftRef.current ? extractDraftSuggestion(reply) : null;
        // Replace the polling-placeholder bubble with the real response
        setMessages((prev) => {
          const withoutPlaceholder = prev.filter((m) => !m.pollingPlaceholder);
          return [
            ...withoutPlaceholder,
            { role: "agent", text: reply, ts: new Date(), draftSuggestion: suggestion ?? undefined },
          ];
        });
      }).catch(() => {
        // Network error — try again next tick
      });
    }, 5_000);
  }, [stopPolling]);

  // Stop polling when the drawer is closed or unmounted
  useEffect(() => {
    if (!isOpen) stopPolling();
  }, [isOpen, stopPolling]);

  useEffect(() => () => stopPolling(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync draft when a new draft is opened
  useEffect(() => {
    if (!emailDraft) return;
    if (emailDraft.itemId === lastDraftItemId.current) return;
    lastDraftItemId.current = emailDraft.itemId;
    setCurrentDraftBody(emailDraft.body);
    setCurrentDraftTo(emailDraft.to);
    currentDraftBodyRef.current = emailDraft.body;
    currentDraftToRef.current = emailDraft.to;
    setToError(false);
    setEmailSentSuccess(false);
    welcomeShown.current = true;
    setMessages([{ role: "agent", text: DRAFT_WELCOME, ts: new Date() }]);
  }, [emailDraft]);

  // Fetch AI-generated reply suggestions when a new draft opens
  useEffect(() => {
    if (!emailDraft) return;

    // Seed immediately with keyword fallback so pills aren't blank before LLM responds
    setSmartReplies(keywordFallbackReplies(emailDraft.subject));
    setIsLoadingReplies(true);

    let cancelled = false;
    void pulseApi
      .suggestReplies({
        subject: emailDraft.subject,
        from: emailDraft.originalFrom ?? "",
        bodySnippet: (emailDraft.originalSnippet ?? emailDraft.body).slice(0, 200),
      })
      .then(({ suggestions }) => {
        if (!cancelled && suggestions.length > 0) setSmartReplies(suggestions);
      })
      .catch(() => { /* fallback already set */ })
      .finally(() => { if (!cancelled) setIsLoadingReplies(false); });

    return () => { cancelled = true; };
  }, [emailDraft?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll only when user is already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  // Show scroll-down button when a new message arrives and user is scrolled up
  useEffect(() => {
    if (messages.length === 0) return;
    if (!isNearBottomRef.current) setShowScrollDown(true);
  }, [messages]);

  // Welcome message on first open
  useEffect(() => {
    if (!isOpen || welcomeShown.current || messages.length > 0) return;
    if (autoSendText || emailDraft) return;
    welcomeShown.current = true;
    setMessages([{ role: "agent", text: buildWelcomeMessage(pendingCount, firstPendingTitle), ts: new Date() }]);
  }, [isOpen]); // intentionally limited — pendingCount/firstPendingTitle intentionally excluded

  // Silent agent prime: send email context to the agent when a new draft opens
  // (no user bubble shown — agent gets context in its session history)
  useEffect(() => {
    if (!isOpen || !agentId || !emailDraft || !sessionId) return;
    if (draftPrimedRef.current === emailDraft.itemId) return;
    draftPrimedRef.current = emailDraft.itemId;

    const primeMsg =
      `I'm reviewing an email draft to ${emailDraft.to || "(unknown recipient)"} ` +
      `about "${emailDraft.subject}". Current draft body:\n${emailDraft.body}\n\n` +
      `Help me edit it when asked.`;

    void (async () => {
      try {
        await agentApi.sendMessage(sessionId, primeMsg);
      } catch {
        // Silent failure is acceptable — this is a best-effort context hint
      }
    })();
  }, [isOpen, agentId, emailDraft, sessionId]);

  // ── Use-this-draft handler ──────────────────────────────────────────────────

  const handleUseDraft = useCallback((newBody: string) => {
    setCurrentDraftBody(newBody);
    currentDraftBodyRef.current = newBody;
    setDraftJustUpdated(true);
    setTimeout(() => setDraftJustUpdated(false), 1500);
    // Scroll messages container to top so the draft textarea is visible
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    // Focus the textarea after scroll animation starts
    setTimeout(() => draftTextareaRef.current?.focus(), 150);
  }, []);

  // ── Send email draft ────────────────────────────────────────────────────────

  const sendEmailDraft = useCallback(async () => {
    const draft = emailDraftRef.current;
    if (!draft) return;

    // Validate To field
    const to = (currentDraftToRef.current || draft.to).trim();
    if (!to) {
      setToError(true);
      toInputRef.current?.focus();
      return;
    }
    setToError(false);

    setIsSendingEmail(true);
    try {
      let body = currentDraftBodyRef.current || draft.body;
      // Append user name if body ends with a bare sign-off and USER_NAME is configured
      if (userDisplayName) {
        const bareSignoff = /\b(best\s+regards|kind\s+regards)[,.]?\s*$/i;
        if (bareSignoff.test(body.trimEnd())) {
          body = body.trimEnd() + "\n" + userDisplayName;
        }
      }
      await pulseApi.sendEmail({ ...draft, to, body });

      // Show brief success overlay, then offer follow-up only when relevant
      setEmailSentSuccess(true);
      onEmailSent?.();
      onQueueRefresh?.();
      setTimeout(() => {
        setEmailSentSuccess(false);
        if (shouldOfferCalendar(draft.subject, currentDraftBodyRef.current)) {
          setCalendarOffer({ recipient: to, subject: draft.subject });
          // Scroll the offer into view (user may be scrolled to top from handleUseDraft)
          setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
        } else {
          onClose();
        }
      }, 1200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Email] Send failed:", e);
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: `Failed to send email: ${msg}`, ts: new Date() },
      ]);
    } finally {
      setIsSendingEmail(false);
    }
  }, [onEmailSent, onQueueRefresh, onClose, userDisplayName]);

  // sendToAgentRef lets handleScheduleFollowUp call sendToAgent without
  // creating a circular dependency (sendToAgent is defined further down).
  const sendToAgentRef = useRef<((text: string) => Promise<void>) | null>(null);

  // ── Calendar follow-up handlers ─────────────────────────────────────────────

  const handleDeclineFollowUp = useCallback(() => {
    setCalendarOffer(null);
    onClose();
  }, [onClose]);

  const handleScheduleFollowUp = useCallback(
    async (title: string, date: string, time: string) => {
      const offer = calendarOffer;
      if (!offer) return;
      setCalendarOffer(null);

      // Build a natural-language request — CreateCalendarEventAction parses it.
      const msg =
        `Schedule a calendar event: "${title}" with ${offer.recipient} ` +
        `on ${date} at ${time}. Please confirm once added.`;

      await sendToAgentRef.current?.(msg);
    },
    [calendarOffer]
  );

  // ── Core send function ──────────────────────────────────────────────────────

  const cancelRequest = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const sendToAgent = useCallback(
    async (text: string) => {
      if (!agentId) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const draft = emailDraftRef.current;

      // Intercept "send it" / "go ahead" shortcuts
      if (draft && SEND_INTENT_RE.test(trimmed)) {
        setMessages((prev) => [...prev, { role: "user", text: trimmed, ts: new Date() }]);
        await sendEmailDraft();
        return;
      }

      sentAtRef.current = new Date();
      setMessages((prev) => [...prev, { role: "user", text: trimmed, ts: new Date() }]);
      setIsLoading(true);

      // ── Draft mode: bypass the ElizaOS agent pipeline entirely ─────────────
      // Providers (ActionQueueProvider etc.) inject queue/calendar context into
      // every agent message. In draft mode we call /pulse/draft-assist directly —
      // a stateless LLM endpoint with a focused email-editor prompt and no
      // provider injection. This prevents the model from responding to the queue
      // instead of editing the email.
      if (draft) {
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          const { reply: rawReply } = await pulseApi.draftAssist({
            subject: draft.subject,
            to: draft.to,
            currentBody: currentDraftBodyRef.current,
            instruction: trimmed,
            originalFrom: draft.originalFrom,
            originalSnippet: draft.originalSnippet,
          });
          if (controller.signal.aborted) return;

          // Strip [CALENDAR_INTENT] marker — show the cleaned reply, then offer
          const hasCalendarIntent = rawReply.includes(CALENDAR_INTENT_MARKER);
          const reply = rawReply.replace(CALENDAR_INTENT_MARKER, "").trim();

          const suggestion = extractDraftSuggestion(reply);
          setMessages((prev) => [
            ...prev,
            {
              role: "agent",
              text: reply || "…",
              ts: new Date(),
              draftSuggestion: suggestion ?? undefined,
            },
          ]);

          if (hasCalendarIntent) {
            setCalendarOffer({ recipient: draft.to, subject: draft.subject });
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") return;
          const message = e instanceof Error ? e.message : "Unknown error";
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: `Sorry, couldn't rewrite the draft: ${message}`, ts: new Date() },
          ]);
        } finally {
          abortRef.current = null;
          setIsLoading(false);
        }
        return;
      }

      // ── Calendar creation: intercept before ElizaOS pipeline ────────────────
      // ElizaOS's model selection is unreliable for triggering actions — the LLM
      // often generates a REPLY that sounds like it created the event but never
      // calls the action handler. We intercept here and hit the route directly,
      // same pattern as draft-assist.
      // Matches: "schedule/book/create X tomorrow at 13:00"
      const CALENDAR_CREATE_RE =
        /\b(schedule|book|set\s+up|create)\b.{0,120}\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|at\s+\d|\d{1,2}:\d{2})/i;
      // Matches: "put/add X into/onto my calendar" (event name can appear between verb and calendar)
      const CALENDAR_EXPLICIT_RE =
        /\b(put|add)\b.{0,120}\b(in(to)?|on(to)?)\s+(my\s+)?(calendar|cal)\b/i;

      if (!draft && (CALENDAR_CREATE_RE.test(trimmed) || CALENDAR_EXPLICIT_RE.test(trimmed))) {
        try {
          const result = await pulseApi.createCalendarEvent(trimmed);
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: result.confirmText, ts: new Date(), positive: true },
          ]);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: `Sorry, I couldn't create the calendar event: ${message}`, ts: new Date() },
          ]);
        } finally {
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          abortRef.current = null;
          setIsLoading(false);
        }
        return;
      }

      // ── Conflict resolution: intercept when chat opened from a conflict card ─
      // If the user says anything that sounds like "reschedule X to Y time",
      // call /pulse/resolve-conflict directly instead of letting ElizaOS hallucinate.
      const RESCHEDULE_RE =
        /\b(reschedule|move|shift|change|push|bump|cancel|drop)\b.{0,120}\b(to\s+\d|at\s+\d|\d{1,2}:\d{2}|[ap]m|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*[ap]m)/i;
      const RESCHEDULE_SIMPLE_RE =
        /\b(reschedule|move it|shift it|change it|can you move|please move|please reschedule)\b/i;

      if (!draft && conflictContext && (RESCHEDULE_RE.test(trimmed) || RESCHEDULE_SIMPLE_RE.test(trimmed))) {
        try {
          const result = await pulseApi.resolveConflict({
            message:     trimmed,
            eventAId:    conflictContext.eventAId,
            eventBId:    conflictContext.eventBId,
            eventATitle: conflictContext.eventATitle,
            eventBTitle: conflictContext.eventBTitle,
            eventAStart: conflictContext.eventAStart,
            eventAEnd:   conflictContext.eventAEnd,
            eventBStart: conflictContext.eventBStart,
            eventBEnd:   conflictContext.eventBEnd,
            date:        conflictContext.date,
          });
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: result.text, ts: new Date(), positive: result.action === "rescheduled" },
          ]);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: `Sorry, I couldn't process that reschedule: ${message}`, ts: new Date() },
          ]);
        } finally {
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          abortRef.current = null;
          setIsLoading(false);
        }
        return;
      }

      // ── General chat: full ElizaOS agent pipeline ───────────────────────────
      const agentText = trimmed;

      const controller = new AbortController();
      abortRef.current = controller;

      // Email rewrites can take longer — give draft mode an extra 60s
      const timeoutMs = draft ? 180_000 : 120_000;

      timeoutRef.current = setTimeout(() => {
        if (abortRef.current === controller) {
          controller.abort();
          abortRef.current = null;
          setIsLoading(false);

          const sid   = currentSessionIdRef.current;
          const after = sentAtRef.current;

          if (sid && after) {
            // Kick off background polling: check every 5s for up to 60s.
            // Show a placeholder bubble with animated dots; it will be
            // replaced in-place by the real response when polling succeeds.
            setMessages((prev) => [
              ...prev,
              {
                role: "agent",
                text: "Still working on it",
                ts: new Date(),
                positive: true,
                pollingPlaceholder: true,
              },
            ]);
            startPolling(sid, after);
          } else {
            setMessages((prev) => [
              ...prev,
              {
                role: "agent",
                text: "Pulse is still working on this. Check your queue in a moment — new items will appear there.",
                ts: new Date(),
                positive: true,
              },
            ]);
            if (onQueueRefresh) setTimeout(onQueueRefresh, 3_000);
          }
        }
      }, timeoutMs);

      try {
        let sid = sessionId;
        if (!sid) {
          const userId = getOrCreateUserId();
          sid = await agentApi.createSession(agentId, userId);
          storeSessionId(sid);
          setSessionId(sid);
        }
        currentSessionIdRef.current = sid;

        let reply: string;
        try {
          reply = await agentApi.sendMessage(sid, agentText, controller.signal);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("SESSION_NOT_FOUND") || errMsg.includes("404")) {
            try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
            const userId = getOrCreateUserId();
            const freshSid = await agentApi.createSession(agentId, userId);
            storeSessionId(freshSid);
            setSessionId(freshSid);
            currentSessionIdRef.current = freshSid;
            reply = await agentApi.sendMessage(freshSid, agentText, controller.signal);
          } else {
            throw err;
          }
        }

        // In draft mode: detect if the reply looks like a rewritten email.
        // Never auto-apply — attach as draftSuggestion for the user to confirm.
        const suggestion = draft ? extractDraftSuggestion(reply) : null;

        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            text: reply || "…",
            ts: new Date(),
            draftSuggestion: suggestion ?? undefined,
          },
        ]);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Unknown error";
        setMessages((prev) => [
          ...prev,
          { role: "agent", text: `Sorry, I couldn't reach the agent. ${message}`, ts: new Date() },
        ]);
        setSessionId(null);
        try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
      } finally {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [agentId, sessionId, sendEmailDraft, onQueueRefresh, startPolling]
  );

  // Keep the ref current so handleScheduleFollowUp can call sendToAgent
  // without a forward-reference issue.
  useEffect(() => { sendToAgentRef.current = sendToAgent; }, [sendToAgent]);

  // ── Auto-send (triggered by "Ask Pulse" card button) ───────────────────────

  useEffect(() => {
    if (!isOpen || !autoSendText || !agentId) return;
    if (processedAutoSend.current === autoSendText) return;
    processedAutoSend.current = autoSendText;
    onAutoSendConsumed();
    welcomeShown.current = true;
    void sendToAgent(autoSendText);
  }, [isOpen, autoSendText, agentId]); // sendToAgent excluded intentionally

  // ── Input handlers ──────────────────────────────────────────────────────────

  function handleMessagesScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowScrollDown(false);
  }

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`;
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    resizeTextarea();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  async function handleSubmit() {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await sendToAgent(text);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const inDraftMode = Boolean(emailDraft);

  return (
    <div
      className={`fixed inset-y-0 right-0 z-30 flex w-96 flex-col border-l border-gray-200 bg-white shadow-xl transition-transform duration-300 ease-in-out ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Email sent success overlay */}
      {emailSentSuccess && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/96 backdrop-blur-sm">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <Check size={30} className="text-green-600" />
          </div>
          <p className="mt-4 text-base font-semibold text-gray-900">Email Sent!</p>
          <p className="mt-1 text-xs text-gray-400">Closing in a moment…</p>
        </div>
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full ${
              inDraftMode ? "bg-green-50" : "bg-indigo-50"
            }`}
          >
            {inDraftMode
              ? <Mail size={14} className="text-green-600" />
              : <MessageSquare size={14} className="text-indigo-600" />
            }
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {inDraftMode ? "Review & Send Email" : "Ask Pulse"}
            </p>
            {inDraftMode && emailDraft && (
              <p className="text-[10px] text-gray-400 truncate max-w-[200px]" title={emailDraft.subject}>
                Re: {emailDraft.subject.slice(0, 40)}{emailDraft.subject.length > 40 ? "…" : ""}
              </p>
            )}
            {!inDraftMode && (agentId ? (
              <p className="text-[10px] font-medium text-green-500">Connected</p>
            ) : (
              <span className="inline-flex items-center gap-0.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1 w-1 rounded-full bg-gray-400 animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          aria-label="Close chat"
        >
          <X size={16} />
        </button>
      </div>

      {/* Draft mode: top Send Email action bar */}
      {inDraftMode && (
        <div className="shrink-0 flex items-center justify-between border-b border-gray-100 bg-green-50/70 px-4 py-2">
          <span className="text-[10px] text-gray-400">
            Edit the draft · click Send when ready
          </span>
          <button
            onClick={() => void sendEmailDraft()}
            disabled={isSendingEmail || !currentDraftBody.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40 active:scale-95"
          >
            {isSendingEmail ? (
              <span className="inline-flex items-center gap-0.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1 w-1 rounded-full bg-white animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            ) : (
              <Send size={11} />
            )}
            Send Email
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
      {showScrollDown && (
        <button
          onClick={() => {
            isNearBottomRef.current = true;
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
            setShowScrollDown(false);
          }}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-md transition-colors hover:bg-indigo-700 active:scale-95"
        >
          <ChevronDown size={12} />
          New message
        </button>
      )}
      <div
        ref={messagesContainerRef}
        className="h-full overflow-y-auto px-4 py-4"
        onScroll={handleMessagesScroll}
      >
        {inDraftMode && emailDraft && (
          <div className="mb-3">
            <DraftBubble
              draft={emailDraft}
              body={currentDraftBody}
              onBodyChange={(v) => { setCurrentDraftBody(v); currentDraftBodyRef.current = v; }}
              to={currentDraftTo}
              onToChange={(v) => { setCurrentDraftTo(v); currentDraftToRef.current = v; setToError(false); }}
              toError={toError}
              toInputRef={toInputRef}
              textareaRef={draftTextareaRef}
              onQuickAction={(msg) => void sendToAgent(msg)}
              justUpdated={draftJustUpdated}
              smartReplies={smartReplies}
              isLoadingReplies={isLoadingReplies}
            />
          </div>
        )}

        {messages.length === 0 && !isLoading ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50">
              <MessageSquare size={22} className="text-indigo-400" />
            </div>
            <p className="text-sm font-medium text-gray-700">Ask Pulse anything</p>
            <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-gray-400">
              I can help you decide how to handle items in your queue.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                msg={msg}
                onUseDraft={inDraftMode ? handleUseDraft : undefined}
              />
            ))}
            {isLoading && <ThinkingDots />}
            {calendarOffer && (
              <CalendarOfferPanel
                offer={calendarOffer}
                onSchedule={(title, date, time) => void handleScheduleFollowUp(title, date, time)}
                onDecline={handleDeclineFollowUp}
              />
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-gray-100 p-4">
        {/* Send Email button — draft mode only (bottom, primary CTA) */}
        {inDraftMode && (
          <button
            onClick={() => void sendEmailDraft()}
            disabled={isSendingEmail || !currentDraftBody.trim()}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]"
          >
            {isSendingEmail ? (
              <>
                <span className="inline-flex items-center gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 rounded-full bg-white animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </span>
                <span>Sending…</span>
              </>
            ) : (
              <>
                <Send size={14} />
                <span>Send Email</span>
              </>
            )}
          </button>
        )}

        {!agentId && (
          <div className="mb-2 flex items-center justify-center gap-1.5 text-xs text-gray-400">
            <span>Pulse is thinking</span>
            <span className="inline-flex items-center gap-0.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 transition-all focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              inDraftMode
                ? 'Ask Pulse to rewrite, or type "send it"…'
                : agentId
                ? "Ask Pulse anything… (Enter to send)"
                : "Connecting…"
            }
            disabled={!agentId || isLoading || isSendingEmail}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none disabled:opacity-50"
            style={{ minHeight: "24px", maxHeight: "84px" }}
          />
          {isLoading ? (
            <button
              onClick={cancelRequest}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600 active:scale-95"
              aria-label="Stop"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => void handleSubmit()}
              disabled={!agentId || !input.trim() || isSendingEmail}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 active:scale-95"
              aria-label="Send message"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-gray-300">
          {inDraftMode
            ? 'Edit the draft above · type "send it" to send immediately'
            : "Shift+Enter for newline · Context-aware via ActionQueueProvider"
          }
        </p>
      </div>
    </div>
  );
}
