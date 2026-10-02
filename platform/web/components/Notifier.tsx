'use client';
import { useEffect } from 'react';
import { fetchAlerts, loadPrefs, loadSeen, saveSeen, timeMs } from '@/lib/alerts';

// Raises desktop notifications for new alert events while any console tab is open.
// The first poll only records what already exists, so opening the console never floods.
export function Notifier() {
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    let alive = true;
    const tick = async () => {
      if (Notification.permission !== 'granted') return;
      const prefs = loadPrefs();
      const events = await fetchAlerts().catch(() => null);
      if (!alive || !events) return;
      const seen = loadSeen();
      const next = new Set(seen ?? []);
      for (const e of events) {
        if (next.has(e.id)) continue;
        next.add(e.id);
        // a signal older than 30 minutes is history, not news
        const fresh = Date.now() - timeMs(e.at) < 30 * 60_000;
        if (seen && fresh && prefs[e.kind] && (e.kind !== 'signal' || e.tone)) {
          const n = new Notification(e.title, { body: e.detail.slice(0, 180), tag: e.id });
          n.onclick = () => { window.focus(); if (e.href) window.location.href = e.href; n.close(); };
        }
      }
      saveSeen(next);
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return null;
}
