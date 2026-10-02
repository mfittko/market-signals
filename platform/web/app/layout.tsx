import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { Notifier } from '@/components/Notifier';

export const metadata: Metadata = {
  title: 'Market Signals',
  description: 'Trading agents per instrument, advising beside the deterministic engine, paper only',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav" aria-label="Main">
          <Link href="/" className="brand">Market Signals</Link>
          <Link href="/">Desk</Link>
          <Link href="/portfolio">Portfolio</Link>          <Link href="/strategies">Strategies</Link>          <Link href="/runs">Runs</Link>
          <Link href="/alerts">Alerts</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <Notifier />
        {children}
      </body>
    </html>
  );
}
