import { found, NotFound } from '@/lib/found';
import InstrumentPage from './InstrumentPage';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!(await found(`/instruments/${encodeURIComponent(slug)}`))) return <NotFound what="Instrument" back="/" backLabel="Back to the desk" />;
  return <InstrumentPage />;
}
