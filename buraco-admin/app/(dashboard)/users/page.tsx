'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { usePaginated } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface User {
  id: string;
  username: string;
  email: string | null;
  coins: number;
  diamonds: number;
  subscriptionStatus: string;
  isBanned: boolean;
  lastSeenAt: string | null;
}

const INPUT_CLS = 'block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white';

function PlanBadge({ status }: { status: string }) {
  if (status === 'PREMIUM') return <Badge variant="yellow">PREMIUM</Badge>;
  if (status === 'BASIC')   return <Badge variant="blue">BASIC</Badge>;
  return <Badge variant="gray">{status}</Badge>;
}

export default function UsersPage() {
  const [page, setPage]     = useState(1);
  const [search, setSearch] = useState('');
  const [query,  setQuery]  = useState('');

  const { items: users, totalPages, loading, refetch } = usePaginated<User>(
    '/admin/users',
    { page, limit: 20, search: query || undefined },
  );

  const [selected,  setSelected]  = useState<User | null>(null);
  const [amount,    setAmount]     = useState('');
  const [currency,  setCurrency]   = useState<'COINS' | 'DIAMONDS'>('COINS');
  const [banReason, setBanReason]  = useState('');

  const creditM = useMutation();
  const deductM = useMutation();
  const banM    = useMutation();

  function openModal(u: User) { setSelected(u); setAmount(''); setBanReason(''); }

  async function handleCredit(type: 'credit' | 'deduct') {
    const n = parseInt(amount);
    if (!amount || isNaN(n) || n <= 0) { toast.error('Enter a valid positive amount.'); return; }
    const mut = type === 'credit' ? creditM : deductM;
    const ok  = await mut.run(() =>
      api.post(`/admin/users/${selected!.id}/${type}`, { currency, amount: n }),
    );
    if (ok) { toast.success(`${type === 'credit' ? 'Credited' : 'Deducted'} ${n.toLocaleString()} ${currency.toLowerCase()}.`); setSelected(null); refetch(); }
    else    toast.error('Operation failed.');
  }

  async function handleBan() {
    const ok = await banM.run(() =>
      api.patch(`/admin/users/${selected!.id}/ban`, {
        isBanned: !selected!.isBanned,
        reason:   !selected!.isBanned ? (banReason.trim() || 'Banned by admin') : undefined,
      }),
    );
    if (ok) { toast.success(selected!.isBanned ? 'User unbanned.' : 'User banned.'); setSelected(null); refetch(); }
    else    toast.error('Operation failed.');
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Players</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage player accounts</p>
        </div>
      </div>

      {/* Search */}
      <form
        onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search); }}
        className="flex gap-2 mb-5"
      >
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username or email…"
            className="block w-full rounded-lg border border-slate-200 pl-8 pr-3 py-2 text-sm
              placeholder:text-slate-400 outline-none transition
              focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
          />
        </div>
        <Button type="submit" size="sm">Search</Button>
      </form>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={8} cols={7} />
        ) : users.length === 0 ? (
          <Empty message="No users found." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Username', 'Email', 'Coins', 'Diamonds', 'Plan', 'Status', 'Last Seen', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3 font-medium text-slate-900">{u.username}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{u.email ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{u.coins.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{u.diamonds.toLocaleString()}</td>
                    <td className="px-4 py-3"><PlanBadge status={u.subscriptionStatus} /></td>
                    <td className="px-4 py-3">
                      <Badge variant={u.isBanned ? 'red' : 'green'}>{u.isBanned ? 'Banned' : 'Active'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/users/${u.id}`} className="text-blue-600 hover:underline text-xs font-medium">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>

      {/* Manage modal */}
      {selected && (
        <Modal
          title={selected.username}
          description={selected.email ?? 'No email on file'}
          onClose={() => setSelected(null)}
        >
          <div className="space-y-5">
            {/* Currency */}
            <section>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Adjust Currency</p>
              <div className="flex gap-2 mb-3">
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as 'COINS' | 'DIAMONDS')}
                  className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="COINS">Coins</option>
                  <option value="DIAMONDS">Diamonds</option>
                </select>
                <input
                  type="number"
                  min="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount"
                  className={`flex-1 ${INPUT_CLS}`}
                />
              </div>
              <div className="flex gap-2">
                <Button variant="success" size="sm" loading={creditM.loading} onClick={() => handleCredit('credit')}>Credit</Button>
                <Button variant="danger"  size="sm" loading={deductM.loading} onClick={() => handleCredit('deduct')}>Deduct</Button>
              </div>
            </section>

            <hr className="border-slate-100" />

            {/* Ban */}
            <section>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                {selected.isBanned ? 'Restore Access' : 'Restrict Access'}
              </p>
              {!selected.isBanned && (
                <input
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="Ban reason (optional)…"
                  className={`${INPUT_CLS} mb-3`}
                />
              )}
              <Button
                variant={selected.isBanned ? 'success' : 'danger'}
                size="sm"
                loading={banM.loading}
                onClick={handleBan}
              >
                {selected.isBanned ? 'Unban User' : 'Ban User'}
              </Button>
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
}
