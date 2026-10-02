import { found, NotFound } from '@/lib/found';
import PositionPage from './PositionPage';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await found(`/positions/${encodeURIComponent(id)}`))) return <NotFound what="Position" back="/" backLabel="Back to the desk" />;
  return <PositionPage id={id} />;
}
