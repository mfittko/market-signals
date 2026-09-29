import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent desk',
  description: 'Trading agents per instrument, running in shadow beside the deterministic engine',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav" aria-label="Main">
          <Link href="/" className="brand">Agent desk</Link>
          <Link href="/">Desk</Link>
          <Link href="/runs">Runs</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
