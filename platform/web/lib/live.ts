'use client';
import { useEffect, useRef, useState } from 'react';

// One EventSource per page. The server resumes from Last-Event-ID after a
// drop, so nothing is missed; consumers refetch state when `tick` changes.
export function useLive(filter?: (e: { runId: number; kind: string }) => boolean) {
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    const es = new EventSource('/api/v1/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('run', (m) => {
      try {
        const e = JSON.parse((m as MessageEvent).data);
        if (filterRef.current && !filterRef.current(e)) return;
      } catch { /* refresh anyway */ }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setTick((t) => t + 1), 250);
    });
    return () => { es.close(); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return { tick, connected };
}

export function useNow(every = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}
