/**
 * BriefingPanel — shows the morning briefing data on the queue view.
 * Data comes from GET /pulse/briefing (MorningBriefingService cache).
 */

import { useState, useRef } from "react";
import { ChevronDown, ChevronUp, Calendar, Mail, Shield, Zap, Volume2, VolumeX } from "lucide-react";
import type { BriefingData } from "../api/pulseApi";

const TYPE_TAG: Record<string, string> = {
  email_draft:         "✉",
  conflict_resolution: "⚠",
  slib_reminder:       "🛡",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso.slice(11, 16);
  }
}

interface Props {
  briefing: BriefingData | null;
  loading: boolean;
}

function buildBriefingText(briefing: BriefingData): string {
  const parts: string[] = [`Good morning. Here is your briefing for ${briefing.dateLabel}.`];

  if (briefing.pendingItems.length > 0) {
    parts.push(
      `You have ${briefing.pendingItems.length} item${briefing.pendingItems.length !== 1 ? "s" : ""} pending in your queue.`
    );
    briefing.pendingItems.slice(0, 3).forEach((item) => {
      parts.push(`Priority ${item.priority}: ${item.title}.`);
    });
  } else {
    parts.push("Your queue is clear.");
  }

  if (briefing.todayEvents.length > 0) {
    parts.push(
      `Today you have ${briefing.todayEvents.length} calendar event${briefing.todayEvents.length !== 1 ? "s" : ""}.`
    );
    briefing.todayEvents.slice(0, 3).forEach((ev) => {
      parts.push(ev.allDay ? `All day: ${ev.title}.` : `${ev.title}.`);
    });
  } else {
    parts.push("No meetings scheduled today.");
  }

  if (briefing.urgentCommitments.length > 0) {
    parts.push(
      `You have ${briefing.urgentCommitments.length} commitment${briefing.urgentCommitments.length !== 1 ? "s" : ""} due soon.`
    );
    briefing.urgentCommitments.slice(0, 2).forEach((c) => {
      parts.push(c.recipient ? `${c.text}, to ${c.recipient}.` : `${c.text}.`);
    });
  }

  parts.push("That is all. Have a productive day.");
  return parts.join(" ");
}

export function BriefingPanel({ briefing, loading }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  function toggleSpeech() {
    if (!briefing) return;

    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    const text = buildBriefingText(briefing);
    const utter = new SpeechSynthesisUtterance(text);
    // Briefing content is always English — pick an English voice regardless of
    // browser locale so it doesn't sound garbled on non-English systems.
    utter.lang = "en-US";
    const voices = window.speechSynthesis.getVoices();
    const enVoice =
      voices.find((v) => v.lang === "en-US" && v.name.toLowerCase().includes("natural")) ??
      voices.find((v) => v.lang === "en-US") ??
      voices.find((v) => v.lang.startsWith("en")) ??
      null;
    if (enVoice) utter.voice = enVoice;
    utter.rate = 1.05;
    utter.pitch = 1;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    utteranceRef.current = utter;
    window.speechSynthesis.speak(utter);
    setSpeaking(true);
  }

  if (loading) {
    return (
      <div className="mb-6 overflow-hidden rounded-xl border border-indigo-100 bg-white shadow-sm">
        <div className="h-14 animate-pulse bg-indigo-50/60" />
      </div>
    );
  }

  if (!briefing) return null;

  const hasPending      = briefing.pendingItems.length > 0;
  const hasEvents       = briefing.todayEvents.length > 0;
  const hasCommitments  = briefing.urgentCommitments.length > 0;

  const generatedTime = new Date(briefing.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-indigo-100 bg-white shadow-sm">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between border-b border-indigo-50 bg-indigo-50/60 px-5 py-3 text-left transition-colors hover:bg-indigo-50"
      >
        <div className="flex items-center gap-2.5">
          <Zap size={14} className="text-indigo-500" />
          <span className="text-sm font-semibold text-indigo-900">Today's Briefing</span>
          <span className="text-xs text-indigo-400">{briefing.dateLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-indigo-400">as of {generatedTime}</span>
          {"speechSynthesis" in window && (
            <button
              onClick={(e) => { e.stopPropagation(); toggleSpeech(); }}
              title={speaking ? "Stop briefing" : "Listen to briefing"}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                speaking
                  ? "bg-indigo-200 text-indigo-700"
                  : "text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600"
              }`}
            >
              {speaking ? <VolumeX size={11} /> : <Volume2 size={11} />}
              {speaking ? "Stop" : "Listen"}
            </button>
          )}
          {collapsed
            ? <ChevronDown size={14} className="text-indigo-400" />
            : <ChevronUp size={14} className="text-indigo-400" />
          }
        </div>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 divide-y divide-gray-50 md:grid-cols-3 md:divide-x md:divide-y-0">
          {/* Queue */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center gap-1.5">
              <Mail size={12} className="text-blue-500" />
              <p className="text-xs font-semibold text-gray-700">
                {hasPending ? `${briefing.pendingItems.length} pending` : "Queue clear"}
              </p>
            </div>
            {hasPending ? (
              <ul className="space-y-1.5">
                {briefing.pendingItems.slice(0, 3).map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600">
                    <span className="shrink-0 text-[11px]">{TYPE_TAG[item.type] ?? "•"}</span>
                    <span className="truncate">{item.title}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">P{item.priority}</span>
                  </li>
                ))}
                {briefing.pendingItems.length > 3 && (
                  <li className="text-xs text-gray-400">+{briefing.pendingItems.length - 3} more</li>
                )}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">Nothing needs your attention</p>
            )}
          </div>

          {/* Calendar */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center gap-1.5">
              <Calendar size={12} className="text-green-500" />
              <p className="text-xs font-semibold text-gray-700">
                {hasEvents ? `${briefing.todayEvents.length} event${briefing.todayEvents.length !== 1 ? "s" : ""} today` : "Free day"}
              </p>
            </div>
            {hasEvents ? (
              <ul className="space-y-1.5">
                {briefing.todayEvents.slice(0, 4).map((ev, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
                    <span className="w-14 shrink-0 text-[10px] text-gray-400">
                      {ev.allDay ? "all-day" : formatTime(ev.start)}
                    </span>
                    <span className="truncate">{ev.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">No meetings scheduled</p>
            )}
          </div>

          {/* Commitments */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center gap-1.5">
              <Shield size={12} className="text-amber-500" />
              <p className="text-xs font-semibold text-gray-700">
                {hasCommitments ? `${briefing.urgentCommitments.length} commitment${briefing.urgentCommitments.length !== 1 ? "s" : ""} due` : "Slib Guard clear"}
              </p>
            </div>
            {hasCommitments ? (
              <ul className="space-y-1.5">
                {briefing.urgentCommitments.slice(0, 3).map((c, i) => (
                  <li key={i} className="text-xs text-gray-600">
                    <span className="block truncate">{c.text}</span>
                    {c.recipient && (
                      <span className="text-[10px] text-gray-400">→ {c.recipient}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">No commitments due in 48h</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
