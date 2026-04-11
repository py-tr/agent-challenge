import { useState, useEffect, useCallback, useRef } from "react";
import {
  pulseApi,
  type ActionItem,
  type StatusResponse,
  type DecisionsResponse,
} from "../api/pulseApi";

const POLL_INTERVAL_MS = 5_000;

export interface QueueState {
  items: ActionItem[];
  status: StatusResponse | null;
  decisions: DecisionsResponse | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  approve: (id: string) => Promise<{ draftCreated: boolean; draftRecipient: string | null }>;
  reject: (id: string, reason?: string) => Promise<void>;
  refresh: () => void;
}

export function useActionQueue(): QueueState {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [decisions, setDecisions] = useState<DecisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Use a ref (not state) for the in-flight ID set so approve/reject callbacks
  // don't need to be recreated on every mutation. Components handle their own
  // busy state locally via ItemCard.
  const mutatingRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [queue, st, dec] = await Promise.all([
        pulseApi.getQueue(),
        pulseApi.getStatus(),
        pulseApi.getDecisions(30),
      ]);
      setItems(queue.items);
      setStatus(st);
      setDecisions(dec);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    void fetchAll();
    intervalRef.current = setInterval(() => void fetchAll(), POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAll]);

  const approve = useCallback(async (id: string): Promise<{ draftCreated: boolean; draftRecipient: string | null }> => {
    if (mutatingRef.current.has(id)) return { draftCreated: false, draftRecipient: null };
    mutatingRef.current.add(id);
    try {
      const result = await pulseApi.approve(id);
      // Optimistic remove from queue
      setItems((prev) => prev.filter((i) => i.id !== id));
      // Refresh decisions in background
      void pulseApi.getDecisions(30).then(setDecisions).catch(() => null);
      void pulseApi.getStatus().then(setStatus).catch(() => null);
      return { draftCreated: result.draftCreated ?? false, draftRecipient: result.draftRecipient ?? null };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return { draftCreated: false, draftRecipient: null };
    } finally {
      mutatingRef.current.delete(id);
    }
  }, []); // stable — no state deps; mutatingRef.current is mutable without re-render

  const reject = useCallback(async (id: string, reason?: string) => {
    if (mutatingRef.current.has(id)) return;
    mutatingRef.current.add(id);
    try {
      await pulseApi.reject(id, reason);
      setItems((prev) => prev.filter((i) => i.id !== id));
      void pulseApi.getDecisions(30).then(setDecisions).catch(() => null);
      void pulseApi.getStatus().then(setStatus).catch(() => null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      mutatingRef.current.delete(id);
    }
  }, []); // stable

  const refresh = useCallback(() => void fetchAll(), [fetchAll]);

  return {
    items,
    status,
    decisions,
    loading,
    error,
    lastUpdated,
    approve,
    reject,
    refresh,
  };
}
