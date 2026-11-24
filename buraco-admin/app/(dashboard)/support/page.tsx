'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { ago } from '@/components/players/bits';

type Status = 'OPEN' | 'ANSWERED' | 'CLOSED';
interface Ticket {
  id: string; status: Status; name: string; email: string; snippet: string; createdAt: string; replies: number;
  user: { id: string; username: string; isBanned: boolean };
}
interface Page { data: Ticket[]; total: number; totalPages: number; counts: Partial<Record<Status, number>> }

const TABS: { status: Status; label: string }[] = [
  { status: 'OPEN', label: 'Waiting' },
  { status: 'ANSWERED', label: 'Answered' },
  { status: 'CLOSED', label: 'Closed' },
];
const STATUS_BADGE: Record<Status, { label: string; v: 'yellow' | 'blue' | 'gray' }> = {
  OPEN: { label: 'Waiting', v: 'yellow' }, ANSWERED: { label: 'Answered', v: 'blue' }, CLOSED: { label: 'Closed', v: 'gray' },
};

export default function SupportPage() {
  const [status, setStatus] = useState<Status>('OPEN');
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading } = useFetch<Page>('/admin/support/tickets', { status, page, limit: 20, ...(search ? { search } : {}) });
  const rows = data?.data ?? [];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Support</h1>
        <p className="text-sm text-slate-500 mt-0.5">Messages players send from Settings → Contact Support. The longest-waiting message is first.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-white border border-slate-200 rounded-xl p-1 w-full sm:w-auto">
          {TABS.map((t) => (
            <button key={t.status} onClick={() => { setStatus(t.status); setPage(1); }}
              className={`flex-1 sm:flex-none px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${status === t.status ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              {t.label}{data?.counts?.[t.status] != null ? ` (${data.counts[t.status]})` : ''}
            </button>
          ))}
        </div>
        <form className="relative sm:ml-auto sm:w-72" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); setPage(1); }}>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Player, email or words"
            className="block w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
        </form>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? <TableSkeleton rows={6} cols={4} /> : rows.length === 0 ? (
          <Empty message={status === 'OPEN' ? 'Nothing is waiting. 🎉' : 'No messages here.'} />
        ) : (
          <>
            <ul className="divide-y divide-slate-50">
              {rows.map((t) => (
                <li key={t.id}>
                  <Link href={`/support/${t.id}`} className="block px-4 py-3 hover:bg-slate-50/60 transition-colors">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {t.user.username}
                        {t.name !== t.user.username && <span className="text-slate-400 font-normal"> · wrote as “{t.name}”</span>}
                      </p>
                      <span className="text-xs text-slate-400 whitespace-nowrap">{ago(t.createdAt)}</span>
                    </div>
                    <p className="text-sm text-slate-600 mt-0.5 line-clamp-2">{t.snippet}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge variant={STATUS_BADGE[t.status].v}>{STATUS_BADGE[t.status].label}</Badge>
                      {t.replies > 0 && <span className="text-[11px] text-slate-400">{t.replies} repl{t.replies === 1 ? 'y' : 'ies'}</span>}
                      {t.user.isBanned && <Badge variant="red">Banned</Badge>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="px-4 pb-3"><Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} /></div>
          </>
        )}
      </div>
    </div>
  );
}
