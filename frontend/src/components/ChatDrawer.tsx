import { useState, useEffect, useRef, useCallback } from "react";
import { X, ArrowUp, Square, MessageSquare, Mail, Send, Check, ChevronDown, Paperclip, FileText, RotateCcw } from "lucide-react";
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
  /**
   * When set, renders doc action chips (Email summary, Copy) below the bubble.
   * Populated on the PDF analysis message so the user can act without typing.
   */
  docChips?: { docId: string; filename: string; text: string };
  /** When set, renders a "Mark as resolved" button that approves the conflict item. */
  resolveItemId?: string;
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
  onResolveConflict,
}: {
  msg: ChatMessage;
  onUseDraft?: (body: string) => void;
  onResolveConflict?: (itemId: string) => void;
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
      {onResolveConflict && msg.resolveItemId && (
        <button
          onClick={() => onResolveConflict(msg.resolveItemId!)}
          className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 active:scale-95"
        >
          <Check size={11} />
          Mark conflict as resolved
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
  // Extract a clean meeting title from the email subject
  const meetingTitle = offer.subject
    .replace(/^(re|fwd?|fw):\s*/i, "")
    .replace(/^(thursday|friday|monday|tuesday|wednesday|saturday|sunday)\s*\d*\w*\s*-?\s*/i, "")
    .trim() || "Meeting";

  return (
    <div className="rounded-xl border p-3 text-xs space-y-2.5" style={{ borderColor: "#bfdbfe", backgroundColor: "#eff6ff" }}>
      <p className="font-medium text-[11px]" style={{ color: "#1e40af" }}>
        📅 Want to add a meeting to your calendar?
      </p>
      <p className="text-[10px]" style={{ color: "#3b82f6" }}>
        Just tell me when — e.g. <em>"add {meetingTitle} Thursday at 3pm"</em>
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onSchedule(meetingTitle, "", "")}
          className="flex-1 rounded-lg px-3 py-1.5 text-[10px] font-semibold text-white transition-colors active:scale-95"
          style={{ backgroundColor: "#2563eb" }}
        >
          Yes, tell me when →
        </button>
        <button
          onClick={onDecline}
          className="rounded-lg border px-3 py-1.5 text-[10px] font-medium transition-colors hover:opacity-80 active:scale-95"
          style={{ borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#6b7280" }}
        >
          No thanks
        </button>
      </div>
    </div>
  );
}

// ─── InlineEmailSend ─────────────────────────────────────────────────────────

interface InlineEmailSendProps {
  draft: { to: string; subject: string; body: string };
  onSent: (to: string) => void;
  onDiscard: () => void;
  userDisplayName?: string;
  /** If set, shows an "Attach PDF" checkbox that sends the doc as an attachment. */
  attachDoc?: { docId: string; filename: string } | null;
}

function InlineEmailSend({ draft, onSent, onDiscard, userDisplayName, attachDoc }: InlineEmailSendProps) {
  const [to, setTo]       = useState(draft.to);
  const [body, setBody]   = useState(draft.body);
  const [sending, setSending] = useState(false);
  const [sent, setSent]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachPdf, setAttachPdf] = useState(!!attachDoc);

  async function handleSend() {
    if (!to.trim()) { setError("Enter a recipient email"); return; }
    setSending(true);
    setError(null);
    try {
      let finalBody = body;
      if (userDisplayName) {
        const bareSignoff = /\b(best\s+regards|kind\s+regards)[,.]?\s*$/i;
        if (bareSignoff.test(finalBody.trimEnd())) {
          finalBody = finalBody.trimEnd() + "\n" + userDisplayName;
        }
      }
      const attachDocIds = attachPdf && attachDoc ? [attachDoc.docId] : undefined;
      await pulseApi.sendDirect({ to: to.trim(), subject: draft.subject, body: finalBody, attachDocIds });
      setSent(true);
      setTimeout(() => onSent(to.trim()), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
        <Check size={14} />
        <span>Email sent to {to}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-indigo-700">
          <Mail size={12} />
          <span>Send Summary</span>
        </div>
        <button onClick={onDiscard} className="text-gray-400 hover:text-gray-600">
          <X size={12} />
        </button>
      </div>

      <div className="mb-1.5">
        <span className="font-medium text-gray-700">To: </span>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="recipient@example.com"
          className="rounded border border-indigo-100 bg-white px-1.5 py-0.5 text-xs text-gray-800 focus:outline-none focus:border-indigo-300 w-full mt-0.5"
        />
      </div>

      <div className="mb-2 text-gray-500">
        <span className="font-medium text-gray-700">Subject:</span> {draft.subject}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="w-full rounded border border-indigo-100 bg-white p-2 text-xs text-gray-800 focus:outline-none focus:border-indigo-300 resize-none mb-2"
      />

      {attachDoc && (
        <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-[11px] text-indigo-700 select-none">
          <input
            type="checkbox"
            checked={attachPdf}
            onChange={(e) => setAttachPdf(e.target.checked)}
            className="accent-indigo-600"
          />
          <Paperclip size={10} />
          <span className="truncate">Attach PDF: {attachDoc.filename}</span>
        </label>
      )}

      {error && <p className="mb-1.5 text-[10px] text-red-500">{error}</p>}

      <button
        onClick={() => void handleSend()}
        disabled={sending || !to.trim()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40 active:scale-[0.98]"
      >
        {sending ? (
          <span className="inline-flex items-center gap-0.5">
            {[0,1,2].map((i) => (
              <span key={i} className="h-1 w-1 rounded-full bg-white animate-bounce" style={{ animationDelay: `${i*150}ms` }} />
            ))}
          </span>
        ) : (
          <><Send size={11} /><span>Send Email</span></>
        )}
      </button>
    </div>
  );
}

// ─── DocActionChips ───────────────────────────────────────────────────────────

interface DocActionChipsProps {
  doc: { filename: string; text: string };
  onEmail: (to: string, doc: { filename: string; text: string }) => void;
}

function DocActionChips({ doc, onEmail }: DocActionChipsProps) {
  const [showInput, setShowInput] = useState(false);
  const [to, setTo] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleEmailClick() {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleSubmit() {
    if (!to.trim()) return;
    onEmail(to.trim(), doc);
    setShowInput(false);
    setTo("");
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {!showInput ? (
        <div className="flex gap-2">
          <button
            onClick={handleEmailClick}
            className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 active:scale-95"
          >
            <Mail size={11} />
            Email summary to…
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(doc.text);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 active:scale-95"
          >
            <FileText size={11} />
            Copy text
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") { setShowInput(false); setTo(""); } }}
            placeholder="recipient@example.com"
            className="flex-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-indigo-400"
          />
          <button
            onClick={handleSubmit}
            disabled={!to.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40 active:scale-95"
          >
            Draft
          </button>
          <button
            onClick={() => { setShowInput(false); setTo(""); }}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 active:scale-95"
          >
            Cancel
          </button>
        </div>
      )}
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
  const [attachedDoc, setAttachedDoc] = useState<{ docId: string; filename: string; text?: string } | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [attachPdfToEmail, setAttachPdfToEmail] = useState(false);
  const [inlineEmailDraft, setInlineEmailDraft] = useState<{ to: string; subject: string; body: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachedDocRef = useRef<{ docId: string; filename: string; text?: string } | null>(null);
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
  useEffect(() => { attachedDocRef.current = attachedDoc; }, [attachedDoc]);

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
      const attachDocIds = attachPdfToEmail && attachedDocRef.current?.docId
        ? [attachedDocRef.current.docId]
        : undefined;
      await pulseApi.sendEmail({ ...draft, to, body }, attachDocIds);

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
  }, []);

  const handleScheduleFollowUp = useCallback(
    async (title: string, _date: string, _time: string) => {
      setCalendarOffer(null);
      // Pre-fill the input so the user can type when — more natural than a form.
      setInput(`Schedule a meeting: "${title}" — `);
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    []
  );

  // ── Document upload ─────────────────────────────────────────────────────────

  const handleFileUpload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: "Only PDF files are supported for document upload.", ts: new Date() },
      ]);
      return;
    }

    setIsUploadingDoc(true);
    const readingText = `Extracting text from "${file.name}"…`;
    setMessages((prev) => [
      ...prev,
      { role: "user", text: `📎 ${file.name}`, ts: new Date() },
      { role: "agent", text: readingText, ts: new Date(), positive: true },
    ]);

    try {
      const result = await pulseApi.uploadDocument(file);

      // Replace the "extracting" placeholder with the full LLM analysis.
      // The analysis is generated server-side by the same LLM path as /draft-assist —
      // no ElizaOS session needed, so no SESSION_NOT_FOUND errors.
      setMessages((prev) => {
        const withoutPlaceholder = prev.filter((m) => m.text !== readingText);
        return [
          ...withoutPlaceholder,
          {
            role: "agent",
            text: result.analysis,
            ts: new Date(),
            docChips: { docId: result.docId, filename: result.filename, text: result.text },
          },
        ];
      });

      // Keep doc attached so follow-up questions still get context injected
      setAttachedDoc({ docId: result.docId, filename: result.filename, text: result.text });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      setMessages((prev) => [
        ...prev.filter((m) => m.text !== readingText),
        { role: "agent", text: `Could not upload document: ${msg}`, ts: new Date() },
      ]);
    } finally {
      setIsUploadingDoc(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []); // no session dependency — analysis is fully server-side

  // ── Doc email chip handler ──────────────────────────────────────────────────
  // Called by the "Email summary to..." chip on the PDF analysis bubble.
  // Takes recipient from an inline input — no natural language parsing needed.
  const handleDocEmail = useCallback(async (toAddr: string, doc: { filename: string; text: string }) => {
    if (!toAddr.trim()) return;
    setIsLoading(true);
    const subject = `Summary: ${doc.filename.replace(/\.pdf$/i, "")}`;
    try {
      const { reply } = await pulseApi.draftAssist({
        subject,
        to: toAddr.trim(),
        currentBody: doc.text.slice(0, 3_000),
        instruction:
          "Draft a concise professional email to the recipient summarising the key points, " +
          "action items, and deadlines from this document. " +
          "Start with Hi [first name], end with Best regards. Keep it under 200 words.",
      });
      const cleanDraft = reply
        .replace(/^```[\w]*\n?/im, "")
        .replace(/\n?```$/m, "")
        .replace(/^---\n?/m, "")
        .replace(/\n?---$/m, "")
        .replace(/\[CALENDAR_INTENT\]/g, "")
        .trim();
      setInlineEmailDraft({ to: toAddr.trim(), subject, body: cleanDraft });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: `Couldn't draft the email: ${msg}`, ts: new Date() },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── New chat reset ──────────────────────────────────────────────────────────
  const handleNewChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setAttachedDoc(null);
    setInlineEmailDraft(null);
    setCalendarOffer(null);
    setInput("");
    setIsLoading(false);
    welcomeShown.current = false;
  }, []);

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

      // ── Calendar creation: intercept before EVERYTHING (including draft mode) ─
      // Matches even when the user is in the email draft drawer — e.g.
      // "put a meeting with Sarah in my calendar at 3pm Thursday".
      const CALENDAR_CREATE_RE =
        /\b(schedule|book|set\s+up|create)\b.{0,120}\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|at\s+\d|\d{1,2}:\d{2})/i;
      const CALENDAR_EXPLICIT_RE =
        /\b(put|add)\b.{0,120}\b(in(to)?|on(to)?)\s+(my\s+)?(calendar|cal)\b/i;

      if (CALENDAR_CREATE_RE.test(trimmed) || CALENDAR_EXPLICIT_RE.test(trimmed)) {
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
            { role: "agent", text: `Couldn't create the event: ${message}`, ts: new Date() },
          ]);
        } finally {
          setIsLoading(false);
        }
        return;
      }

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

      // ── Conflict resolution: intercept when chat opened from a conflict card ─
      const DELETE_RE =
        /\b(delete|remove|cancel|drop|ditch|decline)\b.{0,80}\b(it|event|meeting|1:1|one.on.one|sarah|review|briefing|call|sync|standup|standup)/i;
      const DELETE_SIMPLE_RE =
        /^(delete it|remove it|cancel it|drop it|yes delete|yes remove|delete (event a|event b)|remove (event a|event b))\.?$/i;

      if (!draft && conflictContext && (DELETE_RE.test(trimmed) || DELETE_SIMPLE_RE.test(trimmed))) {
        // Determine which event the user wants to delete based on their message
        const msgLower = trimmed.toLowerCase();
        const titleA = conflictContext.eventATitle.toLowerCase();
        const titleB = conflictContext.eventBTitle.toLowerCase();

        // Score each event: count how many words from the title appear in the message
        const scoreTitle = (title: string) =>
          title.split(/\s+/).filter((w) => w.length > 2 && msgLower.includes(w)).length;

        const scoreA = scoreTitle(titleA);
        const scoreB = scoreTitle(titleB);

        // Pick the better match; if tied, default to eventB (the shorter/conflicting one)
        const targetId    = scoreA > scoreB ? conflictContext.eventAId    : conflictContext.eventBId;
        const targetTitle = scoreA > scoreB ? conflictContext.eventATitle : conflictContext.eventBTitle;

        if (!targetId) {
          setMessages((prev) => [...prev, {
            role: "agent",
            text: `I don't have the event ID for "${targetTitle}". You may need to delete it directly in Google Calendar.`,
            ts: new Date(),
          }]);
          setIsLoading(false);
          return;
        }

        try {
          await pulseApi.deleteEvent({ eventId: targetId, title: targetTitle });
          setMessages((prev) => [...prev, {
            role: "agent",
            text: `Done — "${targetTitle}" has been removed from your calendar.`,
            ts: new Date(),
            positive: true,
          }]);
          if (conflictContext.itemId) {
            await pulseApi.approve(conflictContext.itemId).catch(() => {});
          }
          onQueueRefresh?.();
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          setMessages((prev) => [...prev, {
            role: "agent",
            text: `Sorry, I couldn't delete "${targetTitle}": ${msg}`,
            ts: new Date(),
          }]);
        } finally {
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          abortRef.current = null;
          setIsLoading(false);
        }
        return;
      }

      const RESCHEDULE_RE =
        /\b(reschedule|move|shift|change|push|bump)\b.{0,120}\b(to\s+\d|at\s+\d|\d{1,2}:\d{2}|[ap]m|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*[ap]m)/i;
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
          if (result.action === "rescheduled" && conflictContext.itemId) {
            const itemId = conflictContext.itemId;
            setMessages((prev) => [...prev, {
              role: "agent",
              text: `Check your calendar to confirm there are no other clashes, then mark the conflict as resolved.`,
              ts: new Date(),
              resolveItemId: itemId,
            }]);
            onQueueRefresh?.();
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          const is404 = message.includes("404") || message.includes("Not Found");
          setMessages((prev) => [
            ...prev,
            {
              role: "agent",
              text: is404
                ? "I couldn't find this event in your Google Calendar — it may have already been moved or doesn't exist yet. You can reschedule it directly in Google Calendar."
                : `Sorry, I couldn't reschedule that: ${message}`,
              ts: new Date(),
            },
          ]);
        } finally {
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          abortRef.current = null;
          setIsLoading(false);
        }
        return;
      }

      // ── Intent classifier: runs when a doc is attached ────────────────────
      // Lightweight LLM call (~15 tokens output) that tells us whether the user
      // wants to email the doc or just chat about it. Falls back to general on
      // any error so the chat always keeps working.
      const docForClassify = attachedDocRef.current;
      if (docForClassify?.text != null && !draft && !conflictContext) {
        try {
          const classification = await pulseApi.classifyIntent({
            message: trimmed,
            hasDoc: true,
            docFilename: docForClassify.filename,
          });
          if (classification.intent === "doc_email") {
            const toAddr = classification.params.to ?? "";
            if (toAddr) {
              // Classifier extracted an email address — draft immediately
              setIsLoading(false);
              await handleDocEmail(toAddr, { filename: docForClassify.filename, text: docForClassify.text });
              return;
            } else {
              // Doc email intent but no address — expand the chip's input for them
              setMessages((prev) => [
                ...prev,
                { role: "agent", text: "Sure! Who should I send it to? Use the Email chip below or type an address.", ts: new Date() },
              ]);
              setIsLoading(false);
              return;
            }
          }
          // intent === "general" → fall through to ElizaOS agent
        } catch {
          // Classifier failed — silently fall through to general chat
        }
      }

      // ── General chat: full ElizaOS agent pipeline ───────────────────────────
      // If a document is attached, prepend its extracted text as context so the
      // agent can answer questions about it. Keep the doc attached so the user
      // can use the Email chip later without losing context.
      // Cap at 1500 chars so the full message stays well under ElizaOS's 4000-char limit.
      const docForChat = attachedDocRef.current;
      let agentText = trimmed;
      if (docForChat?.text) {
        agentText = `[Document context — "${docForChat.filename}" — answer from this document only, do not search the web]\n${docForChat.text.slice(0, 1500)}\n\n---\n\n${trimmed}`;
      }

      // ── Calendar context injection ─────────────────────────────────────────
      // When the user asks about their schedule, meetings, or events, fetch
      // real calendar data and prepend it so the agent never hallucinates.
      const CALENDAR_RE = /\b(meeting|event|calendar|schedule|appointment|stand.?up|call|planned|next\s+meeting|next\s+event|do i have|what.*\d{1,2}[:.]\d{2}|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?|prep(are)?.*meeting|prepare me)\b/i;
      if (CALENDAR_RE.test(trimmed) && !docForChat) {
        try {
          const cal = await pulseApi.getCalendarContext();
          if (cal.context && cal.events.length > 0) {
            agentText = `[${cal.context}]\n\n${agentText}`;
          }
        } catch {
          // Calendar fetch failed — continue without context
        }
      }

      // ── Web search guard ───────────────────────────────────────────────────
      // Deterministic code-level check: only allow WEB_SEARCH when the user
      // explicitly signals they want it. Appending this instruction is more
      // reliable than relying on the character file alone with small models.
      const SEARCH_SIGNAL_RE = /\b(search|look up|lookup|google|find online|find on the web|internet|browse|current|latest|news|today'?s?)\b/i;
      if (!SEARCH_SIGNAL_RE.test(trimmed)) {
        agentText = `${agentText}\n\n[System: Answer from your existing context and knowledge. Do not use WEB_SEARCH.]`;
      }

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
        <div className="flex items-center gap-1">
          {!inDraftMode && (
            <button
              onClick={handleNewChat}
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="New chat"
              title="New chat"
            >
              <RotateCcw size={15} />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close chat"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Draft mode: top Send Email action bar */}
      {inDraftMode && (
        <div className="shrink-0 flex flex-col border-b border-gray-100 bg-green-50/70 px-4 py-2 gap-1.5">
          <div className="flex items-center justify-between">
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
          {attachedDoc && (
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-500 select-none">
              <input
                type="checkbox"
                checked={attachPdfToEmail}
                onChange={(e) => setAttachPdfToEmail(e.target.checked)}
                className="accent-green-600"
              />
              <Paperclip size={10} />
              <span className="truncate">Attach PDF: {attachedDoc.filename}</span>
            </label>
          )}
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
          <div className="flex h-full flex-col items-center justify-center text-center px-2">
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
              <div key={i}>
                <MessageBubble
                  msg={msg}
                  onUseDraft={inDraftMode ? handleUseDraft : undefined}
                  onResolveConflict={conflictContext ? async (itemId) => {
                    await pulseApi.approve(itemId).catch(() => {});
                    onQueueRefresh?.();
                  } : undefined}
                />
                {msg.docChips && !inlineEmailDraft && (
                  <DocActionChips
                    doc={msg.docChips}
                    onEmail={handleDocEmail}
                  />
                )}
              </div>
            ))}
            {/* Suggestion chips — shown after welcome message, before user sends anything */}
            {!emailDraft && !conflictContext && messages.length === 1 && messages[0].role === "agent" && !isLoading && (
              <div className="flex flex-col gap-1.5 px-1">
                {[
                  { label: "📬 Check my emails",          prompt: "check my emails" },
                  { label: "📅 Any calendar conflicts?",   prompt: "detect conflicts" },
                  { label: "🔁 Who hasn't replied?",       prompt: "check my follow-ups" },
                  { label: "🧭 Prepare me for a meeting",  prompt: "prepare me for my next meeting" },
                  { label: "🔍 Search the web",            prompt: "search for " },
                ].map(({ label, prompt }) => (
                  <button
                    key={label}
                    onClick={() => {
                      if (prompt.endsWith(" ")) {
                        setInput(prompt);
                        setTimeout(() => textareaRef.current?.focus(), 50);
                      } else {
                        void sendToAgent(prompt);
                      }
                    }}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-xs text-gray-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 active:scale-[0.98]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {isLoading && <ThinkingDots />}
            {inlineEmailDraft && (
              <InlineEmailSend
                draft={inlineEmailDraft}
                userDisplayName={userDisplayName}
                attachDoc={attachedDoc}
                onSent={(to) => {
                  setInlineEmailDraft(null);
                  setMessages((prev) => [
                    ...prev,
                    { role: "agent" as const, text: `Email sent to ${to}.`, ts: new Date() },
                  ]);
                  onQueueRefresh?.();
                }}
                onDiscard={() => setInlineEmailDraft(null)}
              />
            )}
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

        {/* Attached document badge */}
        {attachedDoc && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs text-indigo-700">
            <FileText size={11} />
            <span className="flex-1 truncate">{attachedDoc.filename}</span>
            <button
              onClick={() => setAttachedDoc(null)}
              className="ml-1 text-indigo-400 hover:text-indigo-600"
              aria-label="Remove document"
            >
              <X size={10} />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 transition-all focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileUpload(file);
            }}
          />
          {/* Paperclip upload button — visible only in normal chat mode, not draft mode */}
          {!inDraftMode && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingDoc || isLoading || !agentId}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Upload PDF"
              title="Upload a PDF document"
            >
              {isUploadingDoc ? (
                <span className="inline-flex items-center gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1 w-1 rounded-full bg-gray-400 animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </span>
              ) : (
                <Paperclip size={14} />
              )}
            </button>
          )}
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
