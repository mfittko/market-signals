'use client';
import { useEffect, useRef, useState } from 'react';

// One EventSource per page. The server resumes from Last-Event-ID after a
// drop and re-reads a window behind its cursor for late commits; consumers
// refetch state when `tick` changes. Every reopen of the stream also refetches,
// because a resume can still miss a run event that committed late. A page that
// shows one instrument passes its slug, and the server then also announces
// changes to that instrument's engine signals. Those notices carry no id, so
// the reopen refetch repairs them too.
export function useLive(filter?: (e: { runId: number; kind: string }) => boolean, instrument?: string) {
  const [tick, setTick] = useState(0);
  const [newsTick, setNewsTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setTick((t) => t + 1), 250);
    };
    const es = new EventSource(instrument ? `/api/v1/stream?instrument=${encodeURIComponent(instrument)}` : '/api/v1/stream');
    let opened = false;
    es.onopen = () => {
      setConnected(true);
      if (opened) bump(); // a reconnect may have missed a run event or a signal notice
      opened = true;
    };
    es.onerror = () => setConnected(false);
    es.addEventListener('run', (m) => {
      try {
        const e = JSON.parse((m as MessageEvent).data);
        if (filterRef.current && !filterRef.current(e)) return;
      } catch { /* refresh anyway */ }
      bump();
    });
    es.addEventListener('signal', bump);
    es.addEventListener('news', () => setNewsTick((t) => t + 1));
    return () => { es.close(); if (timer.current) clearTimeout(timer.current); };
  }, [instrument]);
  return { tick, newsTick, connected };
}
export function useNow(every = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}
