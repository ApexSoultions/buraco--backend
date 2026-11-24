'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { RequireRole } from '@/lib/admin';
import { when } from '@/components/players/bits';

interface Purchase {
  id: string; store: string; productId: string; transactionId: string; coins: number;
  environment: string | null; createdAt: string; user: { id: string; username: string };
}
interface Sub {
  id: string; store: string; productId: string; expiresAt: string; isActive: boolean;
  createdAt: string; user: { id: string; username: string };
}
interface PurchasePage {
  data: Purchase[]; total: number; totalPages: number; last24h: number;
  byStore: { store: string; count: number; coins: number }[];
}
interface SubPage { data: Sub[]; total: number; active: number; totalPages: number }

const STORES = [['', 'All'], ['GOOGLE_PLAY', 'Google Play'], ['APPLE', 'App Store'], ['FAKE', 'Test']] as const;
const storeName = (s: string) => (s === 'GOOGLE_PLAY' ? 'Google Play' : s === 'APPLE' ? 'App Store' : s === 'FAKE' ? 'Test (editor)' : s);
const TH = 'text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap';

export default function PurchasesPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Purchases /></RequireRole>;
}

function Purchases() {
  const [tab, setTab] = useState<'coins' | 'subs'>('coins');
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Store purchases</h1>
        <p className="text-sm text-slate-500 mt-0.5">Real-money purchases verified with Google Play and the App Store.</p>
      </div>
      <div className="flex gap-1 mb-4 bg-white border border-slate-200 rounded-xl p-1 w-full sm:w-auto sm:inline-flex">
        {([['coins', 'Coin packs'], ['subs', 'Subscriptions']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 sm:flex-none px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === k ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'coins' ? <CoinPurchases /> : <Subscriptions />}
    </div>
  );
}

function CoinPurchases() {
  const [page, setPage] = useState(1);
  const [store, setStore] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading } = useFetch<PurchasePage>('/admin/economy/purchases', { page, limit: 20, ...(store ? { store } : {}), ...(search ? { search } : {}) });
  const rows = data?.data ?? [];

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Purchases (last 24 h)" value={data?.last24h} />
        {(data?.byStore ?? []).map((s) => <Stat key={s.store} label={`${storeName(s.store)}, all time`} value={s.count} sub={`${s.coins.toLocaleString()} coins sold`} />)}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="flex gap-1 bg-white border border-slate-200 rounded-xl p-1 overflow-x-auto">
          {STORES.map(([k, label]) => (
            <button key={k} onClick={() => { setStore(k); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${store === k ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>
          ))}
        </div>
        <form className="relative sm:ml-auto sm:w-72" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Player, product or transaction"
            className="block w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
        </form>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={6} cols={6} /> : rows.length === 0 ? <Empty message="No purchases found." /> : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>{['When', 'Player', 'Store', 'Product', 'Coins', 'Transaction'].map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{when(r.createdAt)}</td>
                    <td className="px-4 py-3"><Link href={`/users/${r.user.id}`} className="font-medium text-blue-600 hover:underline">{r.user.username}</Link></td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant={r.store === 'FAKE' ? 'yellow' : 'blue'}>{storeName(r.store)}</Badge>
                      {r.environment && <span className="ml-1.5 text-[11px] text-slate-400">{r.environment}</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.productId}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{r.coins.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400 max-w-[14rem] truncate" title={r.transactionId}>{r.transactionId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3"><Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} /></div>
          </>
        )}
      </div>
    </>
  );
}

function Subscriptions() {
  const [page, setPage] = useState(1);
  const { data, loading } = useFetch<SubPage>('/admin/economy/subscriptions', { page, limit: 20 });
  const rows = data?.data ?? [];
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Active now" value={data?.active} />
        <Stat label="All time" value={data?.total} />
      </div>
      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={6} cols={5} /> : rows.length === 0 ? <Empty message="No subscriptions yet." /> : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>{['Player', 'Store', 'Product', 'Expires', 'Status'].map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3"><Link href={`/users/${r.user.id}`} className="font-medium text-blue-600 hover:underline">{r.user.username}</Link></td>
                    <td className="px-4 py-3"><Badge variant={r.store === 'FAKE' ? 'yellow' : 'blue'}>{storeName(r.store)}</Badge></td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.productId}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{when(r.expiresAt)}</td>
                    <td className="px-4 py-3"><Badge variant={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Ended'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3"><Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} /></div>
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value?: number; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-semibold text-slate-900 tabular-nums mt-1">{value == null ? '—' : value.toLocaleString()}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}
