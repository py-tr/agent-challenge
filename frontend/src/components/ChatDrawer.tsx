import { useState, useEffect, useRef, useCallback } from "react";
import { X, ArrowUp, Square, MessageSquare } from "lucide-react";
import { agentApi } from "../api/pulseApi";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "agent";
  text: string;
  ts: Date;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  agentId: string | null;
  /** When set, the drawer auto-sends this message (used by "Ask Pulse" card button). */
  autoSendText: string | null;
  /** Called after autoSendText has been processed so the parent can clear it. */
  onAutoSendConsumed: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WELCOME =
  "Hi! I'm Pulse, your Chief of Staff. I can see your current queue and help you decide how to handle each item. What would you like to work through?";

const SESSION_STORAGE_KEY = "pulse_session_id";
const USER_ID_KEY = "pulse_user_id";

function getOrCreateUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

function getStoredSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // sessionStorage unavailable — continue without persistence
  }
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

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "rounded-tr-sm bg-indigo-600 text-white"
            : "rounded-tl-sm bg-gray-100 text-gray-900"
        }`}
      >
        {msg.text}
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
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(getStoredSessionId);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const processedAutoSend = useRef<string | null>(null);
  const welcomeShown = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Show welcome message when drawer first opens with no prior messages
  useEffect(() => {
    if (!isOpen || welcomeShown.current || messages.length > 0) return;
    // Skip welcome if there's a pending auto-send — the auto-send effect handles it
    if (autoSendText) return;
    welcomeShown.current = true;
    setMessages([{ role: "agent", text: WELCOME, ts: new Date() }]);
  }, [isOpen]); // intentionally limited — run only on open change

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

      // Append user message
      setMessages((prev) => [...prev, { role: "user", text: trimmed, ts: new Date() }]);
      setIsLoading(true);

      // Fresh AbortController for this request
      const controller = new AbortController();
      abortRef.current = controller;

      // 120s timeout — email processing can take 60-90s on Nosana nodes
      timeoutRef.current = setTimeout(() => {
        if (abortRef.current === controller) {
          controller.abort();
          abortRef.current = null;
          setIsLoading(false);
          setMessages((prev) => [
            ...prev,
            { role: "agent", text: "No response after 120s. The agent may still be processing — check your queue.", ts: new Date() },
          ]);
        }
      }, 120_000);

      try {
        // Lazily create session if needed
        let sid = sessionId;
        if (!sid) {
          const userId = getOrCreateUserId();
          sid = await agentApi.createSession(agentId, userId);
          storeSessionId(sid);
          setSessionId(sid);
        }

        let reply: string;
        try {
          reply = await agentApi.sendMessage(sid, trimmed, controller.signal);
        } catch (err) {
          // Stale session after backend restart — create a new one and retry once
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("SESSION_NOT_FOUND") || errMsg.includes("404")) {
            try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
            const userId = getOrCreateUserId();
            const freshSid = await agentApi.createSession(agentId, userId);
            storeSessionId(freshSid);
            setSessionId(freshSid);
            reply = await agentApi.sendMessage(freshSid, trimmed, controller.signal);
          } else {
            throw err;
          }
        }

        setMessages((prev) => [
          ...prev,
          { role: "agent", text: reply || "…", ts: new Date() },
        ]);
      } catch (err) {
        // Ignore abort errors — user cancelled intentionally
        if (err instanceof Error && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Unknown error";
        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            text: `Sorry, I couldn't reach the agent. ${message}`,
            ts: new Date(),
          },
        ]);
        setSessionId(null);
        try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
      } finally {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [agentId, sessionId]
  );

  // ── Auto-send (triggered by "Ask Pulse" card button) ───────────────────────

  useEffect(() => {
    if (!isOpen || !autoSendText || !agentId) return;
    if (processedAutoSend.current === autoSendText) return;
    processedAutoSend.current = autoSendText;
    onAutoSendConsumed();
    welcomeShown.current = true; // suppress welcome since we're sending immediately
    void sendToAgent(autoSendText);
  }, [isOpen, autoSendText, agentId]); // sendToAgent excluded intentionally — stale closure is fine here

  // ── Input handlers ──────────────────────────────────────────────────────────

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`; // max ≈ 3 rows
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

  return (
    <div
      className={`fixed inset-y-0 right-0 z-30 flex w-96 flex-col border-l border-gray-200 bg-white shadow-xl transition-transform duration-300 ease-in-out ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-50">
            <MessageSquare size={14} className="text-indigo-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Ask Pulse</p>
            {agentId ? (
              <p className="text-[10px] text-green-500 font-medium">Connected</p>
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
            )}
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
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
              <MessageBubble key={i} msg={msg} />
            ))}
            {isLoading && <ThinkingDots />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-gray-100 p-4">
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
        <div className="flex items-end gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={agentId ? "Ask Pulse anything… (Enter to send)" : "Connecting…"}
            disabled={!agentId || isLoading}
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
              disabled={!agentId || !input.trim()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              aria-label="Send message"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-gray-300">
          Shift+Enter for newline · Context-aware via ActionQueueProvider
        </p>
      </div>
    </div>
  );
}
