'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { Comparison, Status } from '@/lib/api';
import { useNow } from '@/lib/live';

const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued', running: 'Running', waiting_for_event: 'Waiting', awaiting_approval: 'Needs approval',
  succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
};

export function StatusPill({ status, cancelRequested }: { status: Status; cancelRequested?: boolean }) {
  const label = cancelRequested && status === 'running' ? 'Cancelling' : STATUS_LABEL[status] ?? status;
  return <span className={`pill s-${status}`}>{label}</span>;
}

const CMP: Record<Comparison, [string, string]> = {
  agree: ['Agrees with engine', 'c-agree'],
  differ: ['Differs from engine', 'c-differ'],
  pending: ['Awaiting comparison', 'c-pending'],
  no_legacy: ['No engine decision', 'c-pending'],
};

export function ComparisonPill({ value, status }: { value: Comparison; status?: Status }) {
  if (status === 'cancelled') return <span className="muted">–</span>;
  const [label, cls] = CMP[value] ?? [value, 'c-pending'];
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function Card({ title, aside, children, className = '' }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <header className="card-h">
          {title && <h2>{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-v">{value}</div>
      <div className="stat-l">{label}</div>
      {hint && <div className="stat-h">{hint}</div>}
    </div>
  );
}

export function ago(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Ago({ iso }: { iso?: string }) {
  const now = useNow();
  if (!iso) return null;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{ago(iso, now)}</time>;
}

export function Json({ value, max = 40 }: { value: unknown; max?: number }) {
  const text = JSON.stringify(value, null, 2) ?? '';
  const lines = text.split('\n');
  return (
    <details className="json">
      <summary>{lines.length > max ? `${lines.length} lines` : 'JSON'}</summary>
      <pre>{text}</pre>
    </details>
  );
}

// Centered loading state. It stays blank for 200 ms, so a fast load never flashes text.
export function Loading({ full = false }: { full?: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 200); return () => clearTimeout(t); }, []);
  return <div className={`loading${full ? ' full' : ''}`} role="status" aria-live="polite">{show ? 'Loading…' : ''}</div>;
}
