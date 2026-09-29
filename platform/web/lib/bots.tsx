'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Instruments whose engine paper bot is switched on, with the timeframes it trades.
// The engine owns this switch (Settings edits it), so read it live from there.
export function useActiveBots(): Map<string, string[]> | null {
  const [bots, setBots] = useState<Map<string, string[]> | null>(null);
  useEffect(() => {
    let dead = false;
    api<{ bot?: { bots?: Record<string, { enabled?: boolean }> } }>('/engine/settings')
      .then((s) => {
        const m = new Map<string, string[]>();
        for (const [combo, b] of Object.entries(s.bot?.bots ?? {})) {
          if (!b.enabled) continue;
          const [inst, gran] = combo.split('|');
          m.set(inst, [...(m.get(inst) ?? []), gran]);
        }
        if (!dead) setBots(m);
      })
      .catch(() => { if (!dead) setBots(new Map()); }); // engine offline: show no indicator rather than a wrong one
    return () => { dead = true; };
  }, []);
  return bots;
}

export function BotBadge({ grans }: { grans?: string[] }) {
  if (!grans || grans.length === 0) return null;
  return (
    <span className="bot-on" title="The engine's paper bot is on for this instrument">
      <span className="dot" aria-hidden="true" />Bot on · {grans.join(' ')}
    </span>
  );
}
