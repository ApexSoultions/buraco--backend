'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, ChevronRight, Coins, Heart } from 'lucide-react';
import { usePaginated } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { PlanBadge, ago } from '@/components/players/bits';

interface Player {
  id: string;
  username: string;
  email: string | null;
  coins: number;
  lives: number;
  subscriptionStatus: string;
  isBanned: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export default function PlayersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const { items: players, totalPages, loading } = usePaginated<Player>(
    '/admin/users',
    { page, limit: 20, search: query || undefined },
  );

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Players</h1>
        <p className="text-sm text-slate-500 mt-0.5">Search a player, then open them to give coins or lives, ban, reset a name or add a note</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }} className="flex gap-2 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or email…"
            className="block w-full rounded-lg border border-slate-200 pl-8 pr-3 py-2.5 sm:py-2 text-sm bg-white
              placeholder:text-slate-400 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <Button type="submit">Search</Button>
        {query && <Button type="button" variant="ghost" onClick={() => { setSearch(''); setQuery(''); setPage(1); }}>Clear</Button>}
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : players.length === 0 ? (
          <Empty message={query ? `No player matches “${query}”.` : 'No players yet.'} />
        ) : (
          <>
            {/* Wide screens: table */}
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Player', 'Coins', 'Lives', 'Plan', 'Status', 'Last seen', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {players.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/users/${p.id}`)}>
                    <td className="px-4 py-3">
                      <Link href={`/users/${p.id}`} className="font-medium text-slate-900 hover:text-blue-600" onClick={(e) => e.stopPropagation()}>{p.username}</Link>
                      <p className="text-xs text-slate-400">{p.email ?? 'Google / Apple login'}</p>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{p.coins.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{p.lives}</td>
                    <td className="px-4 py-3"><PlanBadge status={p.subscriptionStatus} /></td>
                    <td className="px-4 py-3"><Badge variant={p.isBanned ? 'red' : 'green'}>{p.isBanned ? 'Banned' : 'Active'}</Badge></td>
                    <td className="px-4 py-3 text-xs text-slate-500">{ago(p.lastSeenAt)}</td>
                    <td className="px-4 py-3 text-right text-slate-300"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Phones: one card per player */}
            <ul className="md:hidden divide-y divide-slate-100">
              {players.map((p) => (
                <li key={p.id}>
                  <Link href={`/users/${p.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900 truncate">{p.username}</span>
                        {p.isBanned && <Badge variant="red">Banned</Badge>}
                        {p.subscriptionStatus !== 'FREE' && <PlanBadge status={p.subscriptionStatus} />}
                      </div>
                      <p className="text-xs text-slate-400 truncate">{p.email ?? 'Google / Apple login'}</p>
                      <p className="text-xs text-slate-500 mt-1 flex items-center gap-3">
                        <span className="flex items-center gap-1"><Coins size={12} /> {p.coins.toLocaleString()}</span>
                        <span className="flex items-center gap-1"><Heart size={12} /> {p.lives}</span>
                        <span>seen {ago(p.lastSeenAt)}</span>
                      </p>
                    </div>
                    <ChevronRight size={18} className="text-slate-300 shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>

            <div className="px-4 pb-3">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
