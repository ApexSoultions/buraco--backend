'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { usePaginated } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { RequireRole } from '@/lib/admin';

interface Club {
  id: string; name: string; mode: string; type: string; memberCount: number; maxMembers: number;
  level: number; points: number; createdAt: string;
  leader: { id: string; username: string } | null;
}

const MODES = [['', 'All modes'], ['CLASSIC', 'Classic'], ['PROFESSIONAL', 'Professional']] as const;
const TYPES = [['', 'Open and request'], ['OPEN', 'Open'], ['REQUEST_BASED', 'Request only']] as const;
const TH = 'text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap';
const SEL = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export default function ClubsPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><Clubs /></RequireRole>;
}

function Clubs() {
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('');
  const [type, setType] = useState('');
  const { items: clubs, totalPages, loading } = usePaginated<Club>('/admin/clubs', {
    page, limit: 20, ...(search ? { search } : {}), ...(mode ? { mode } : {}), ...(type ? { type } : {}),
  });

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Clans</h1>
        <p className="text-sm text-slate-500 mt-0.5">Best clans first. Open a clan to see its members and moderate it.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <form className="relative flex-1" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); setPage(1); }}>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search clan name…"
            className="block w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
        </form>
        <select value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }} className={SEL}>
          {MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className={SEL}>
          {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={8} cols={7} /> : clubs.length === 0 ? <Empty message="No clans found." /> : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>{['Clan', 'Leader', 'Mode', 'Join', 'Members', 'Level', 'Points', 'Created'].map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {clubs.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3"><Link href={`/clubs/${c.id}`} className="font-medium text-blue-600 hover:underline">{c.name}</Link></td>
                    <td className="px-4 py-3 text-slate-700">{c.leader?.username ?? <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3"><Badge variant={c.mode === 'PROFESSIONAL' ? 'blue' : 'gray'}>{c.mode === 'PROFESSIONAL' ? 'Professional' : 'Classic'}</Badge></td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{c.type === 'OPEN' ? 'Open' : 'Request only'}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{c.memberCount} / {c.maxMembers}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{c.level}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{c.points.toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3"><Pagination page={page} totalPages={totalPages} onChange={setPage} /></div>
          </>
        )}
      </div>
    </div>
  );
}
