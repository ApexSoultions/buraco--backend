'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, X } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Badge from '@/components/ui/Badge';
import { RequireRole } from '@/lib/admin';
import { ago } from '@/components/players/bits';
import { ReasonBadge, ReportSource, ReportStatus, SOURCE_LABEL, StatusBadge } from '@/components/moderation/bits';

interface Row {
  id: string;
  status: ReportStatus;
  reason: string;
  source: ReportSource;
  snippet: string | null;
  createdAt: string;
  reporter: { id: string; username: string };
  reportedUser: { id: string; username: string; isBanned: boolean };
  openAgainstUser: number;
}
interface Page { data: Row[]; totalPages: number; counts: Partial<Record<ReportStatus, number>> }

const TABS: { status: ReportStatus; label: string }[] = [
  { status: 'OPEN', label: 'Open' },
  { status: 'REVIEWED', label: 'Handled' },
  { status: 'DISMISSED', label: 'Dismissed' },
];

export default function ReportsPage() {
  return (
    <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}>
      <Suspense><Reports /></Suspense>
    </RequireRole>
  );
}

function Reports() {
  const params = useSearchParams();
  const userId = params.get('userId') ?? undefined;
  const [status, setStatus] = useState<ReportStatus>('OPEN');
  const [page, setPage] = useState(1);
  const { data, loading } = useFetch<Page>('/admin/reports', { status, page, limit: 20, userId });
  const rows = data?.data ?? [];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Reports</h1>
        <p className="text-sm text-slate-500 mt-0.5">Players reported by other players from chats. Open one to read what was written, then handle it.</p>
      </div>

      {userId && (
        <div className="mb-4 flex items-center gap-2 text-sm bg-blue-50 text-blue-800 border border-blue-100 rounded-lg px-3 py-2">
          Showing reports against one player only.
          <Link href="/reports" className="ml-auto flex items-center gap-1 text-blue-700 hover:underline"><X size={14} /> Show all</Link>
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-white border border-slate-200 rounded-xl p-1 w-full sm:w-auto sm:inline-flex">
        {TABS.map((t) => (
          <button key={t.status} onClick={() => { setStatus(t.status); setPage(1); }}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition
              ${status === t.status ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
            {t.label}{data?.counts?.[t.status] ? ` (${data.counts[t.status]})` : ''}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading && !data ? <TableSkeleton rows={6} cols={4} /> : rows.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-12">
            {status === 'OPEN' ? 'No open reports. 👍' : 'Nothing here.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/reports/${r.id}`} className="flex items-start gap-3 px-4 py-3.5 hover:bg-slate-50 active:bg-slate-50">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-slate-900">{r.reportedUser.username}</span>
                      {r.reportedUser.isBanned && <Badge variant="red">Banned</Badge>}
                      {r.openAgainstUser > 1 && <Badge variant="red">{r.openAgainstUser} open reports</Badge>}
                      <ReasonBadge reason={r.reason} />
                      {status !== 'OPEN' && <StatusBadge status={r.status} />}
                    </div>
                    {r.snippet && <p className="text-sm text-slate-600 mt-1 line-clamp-2">“{r.snippet}”</p>}
                    <p className="text-xs text-slate-400 mt-1">
                      {SOURCE_LABEL[r.source]} · reported by {r.reporter.username} · {ago(r.createdAt)}
                    </p>
                  </div>
                  <ChevronRight size={18} className="text-slate-300 shrink-0 mt-1" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 && <div className="px-4 pb-3"><Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} /></div>}
      </div>
    </div>
  );
}
