'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { usePaginated } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge, { BadgeVariant } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface Game {
  id: string;
  mode: string;
  variant: string;
  status: string;
  startedAt: string | null;
  players: { userId: string }[];
}

const STATUS_COLOR: Record<string, BadgeVariant> = {
  WAITING:     'yellow',
  IN_PROGRESS: 'blue',
  COMPLETED:   'green',
  ABANDONED:   'gray',
  VOIDED:      'red',
};

const STATUSES = ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED', 'VOIDED'];

export default function GamesPage() {
  const [page,      setPage]      = useState(1);
  const [status,    setStatus]    = useState('');
  const [voidGame,  setVoidGame]  = useState<Game | null>(null);
  const [reason,    setReason]    = useState('');
  const voidM = useMutation();

  const { items: games, totalPages, loading, refetch } = usePaginated<Game>(
    '/admin/games',
    { page, limit: 20, status: status || undefined },
  );

  async function handleVoid() {
    if (!reason.trim()) { toast.error('Please provide a reason.'); return; }
    const ok = await voidM.run(() =>
      api.patch(`/admin/games/${voidGame!.id}/void`, { reason: reason.trim() }),
    );
    if (ok) { toast.success('Game voided.'); setVoidGame(null); setReason(''); refetch(); }
    else    toast.error('Failed to void game.');
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Matches</h1>
        <p className="text-sm text-slate-500 mt-0.5">Monitor game sessions</p>
      </div>

      {/* Filter */}
      <div className="mb-5">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none
            focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-slate-700"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : games.length === 0 ? (
          <Empty message="No game sessions found." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['ID', 'Mode', 'Variant', 'Status', 'Players', 'Started', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {games.map((g) => (
                  <tr key={g.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{g.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 text-slate-700">{g.mode}</td>
                    <td className="px-4 py-3 text-slate-700">{g.variant}</td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_COLOR[g.status] ?? 'gray'}>{g.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{g.players.length}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {g.startedAt ? new Date(g.startedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {g.status === 'IN_PROGRESS' && (
                        <button
                          onClick={() => { setVoidGame(g); setReason(''); }}
                          className="text-red-500 hover:underline text-xs font-medium"
                        >
                          Void
                        </button>
                      )}
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

      {voidGame && (
        <Modal
          title="Void Game"
          description={`Game ID: ${voidGame.id}`}
          onClose={() => setVoidGame(null)}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setVoidGame(null)}>Cancel</Button>
              <Button variant="danger" loading={voidM.loading} onClick={handleVoid}>Void Game</Button>
            </>
          }
        >
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for voiding…"
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm
              placeholder:text-slate-400 outline-none transition
              focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
          />
        </Modal>
      )}
    </div>
  );
}
