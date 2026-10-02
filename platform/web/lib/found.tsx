import Link from 'next/link';

// Server side only. A detail page asks the control plane whether its id exists before it
// renders the client view. An unknown id then renders an inline not-found state, and the
// browser never makes a request that answers 404 and logs a console error.
const API = process.env.MS_API_URL ?? 'http://127.0.0.1:8080';

export async function found(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/v1${path}`, { cache: 'no-store' });
    return res.status !== 404 && res.status !== 400;
  } catch {
    return true; // control plane unreachable: the client view shows the error
  }
}

export function NotFound({ what, back, backLabel }: { what: string; back: string; backLabel: string }) {
  return (
    <main className="wrap">
      <p className="crumb"><Link href={back}>{backLabel}</Link></p>
      <h1>{what} not found</h1>
      <p className="muted">No {what.toLowerCase()} matches this address.</p>
    </main>
  );
}
