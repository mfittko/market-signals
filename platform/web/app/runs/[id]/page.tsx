import { found, NotFound } from '@/lib/found';
import RunPage from './RunPage';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await found(`/runs/${encodeURIComponent(id)}`))) return <NotFound what="Run" back="/runs" backLabel="Back to runs" />;
  return <RunPage />;
}
