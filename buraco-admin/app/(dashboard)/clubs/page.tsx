'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { usePaginated } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface Club {
  id: string;
  name: string;
  mode: string;
  type: string;
  memberCount: number;
  level: number;
  points: number;
  createdAt: string;
}

interface ClubDetail {
  id: string;
  name: string;
  mode: string;
  type: string;
  welcomeMessage: string | null;
  memberCount: number;
  level: number;
  points: number;
  minPoints: number;
  createdAt: string;
  members: Array<{
    userId: string;
    role: string;
    status: string;
    joinedAt: string;
    user: { username: string; email: string };
  }>;
}

export default function ClubsPage() {
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState('');
  const [query, setQuery]     = useState('');
  const [selected, setSelected] = useState<ClubDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Club | null>(null);
  const [deleteReason, setDeleteReason]   = useState('');
  const [deleting, setDeleting] = useState(false);

  const { items: clubs, totalPages, loading } = usePaginated<Club>(
    '/admin/clubs', { page, limit: 20, search: query },
  );

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQuery(search);
  }

  async function openDetail(club: Club) {
    setLoadingDetail(true);
    try {
      const res = await api.get(`/admin/clubs/${club.id}`);
      setSelected(res.data.data ?? res.data);
    } catch {
      toast.error('Failed to load club detail');
    } finally {
      setLoadingDetail(false);
    }
  }

  async function removeMember(clubId: string, userId: string, username: string) {
    try {
      await api.delete(`/admin/clubs/${clubId}/members/${userId}`);
      toast.success(`Removed ${username}`);
      // refresh detail
      const res = await api.get(`/admin/clubs/${clubId}`);
      setSelected(res.data.data ?? res.data);
    } catch {
      toast.error('Failed to remove member');
    }
  }

  async function deleteClub() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/admin/clubs/${confirmDelete.id}`);
      toast.success(`Club "${confirmDelete.name}" deleted`);
      setConfirmDelete(null);
      setDeleteReason('');
      setSelected(null);
      setPage(1);
    } catch {
      toast.error('Failed to delete club');
    } finally {
      setDeleting(false);
    }
  }

  const roleColor: Record<string, 'blue' | 'yellow' | 'gray'> = {
    LEADER: 'blue', VICE_LEADER: 'yellow', MEMBER: 'gray',
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Clans</h1>
        <p className="text-sm text-slate-500 mt-0.5">Browse, inspect, and moderate clubs</p>
      </div>

      {/* Search */}
      <form onSubmit={submitSearch} className="flex gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search club name…"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
        />
        <Button type="submit" size="sm">Search</Button>
      </form>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : clubs.length === 0 ? (
          <Empty message="No clubs found." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Club', 'Mode', 'Members', 'Level', 'Points', 'Created', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {clubs.map((club) => (
                  <tr key={club.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{club.name}</p>
                      <p className="text-xs text-slate-400 font-mono">{club.id.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={club.mode === 'PROFESSIONAL' ? 'blue' : 'gray'}>{club.mode}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{club.memberCount}</td>
                    <td className="px-4 py-3 text-slate-700">{club.level}</td>
                    <td className="px-4 py-3 text-slate-700">{club.points.toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {new Date(club.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => openDetail(club)}
                          className="text-xs font-medium text-blue-600 hover:underline"
                        >
                          Inspect
                        </button>
                        <button
                          onClick={() => setConfirmDelete(club)}
                          className="text-xs font-medium text-red-500 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
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

      {/* Club Detail Modal */}
      {(!!selected || loadingDetail) && (
      <Modal
        onClose={() => setSelected(null)}
        title={selected ? `Club: ${selected.name}` : 'Loading…'}
      >
        {loadingDetail ? (
          <p className="text-sm text-slate-500 py-4 text-center">Loading club detail…</p>
        ) : selected ? (
          <div className="space-y-4">
            {/* Meta */}
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'Level',   val: selected.level },
                { label: 'Members', val: selected.memberCount },
                { label: 'Points',  val: selected.points.toLocaleString() },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-50 rounded-lg p-3">
                  <p className="text-lg font-bold text-slate-800">{val}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>

            {selected.welcomeMessage && (
              <p className="text-sm text-slate-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                "{selected.welcomeMessage}"
              </p>
            )}

            {/* Members */}
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Members</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {selected.members.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{m.user.username}</p>
                      <p className="text-xs text-slate-400">{m.user.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={roleColor[m.role] ?? 'gray'}>{m.role.replace('_', ' ')}</Badge>
                      {m.role !== 'LEADER' && (
                        <button
                          onClick={() => removeMember(selected.id, m.userId, m.user.username)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => { setConfirmDelete({ id: selected.id, name: selected.name } as Club); setSelected(null); }}
              >
                Delete Club
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
      )}

      {/* Delete Confirmation */}
      {!!confirmDelete && (
      <Modal
        onClose={() => { setConfirmDelete(null); setDeleteReason(''); }}
        title={`Delete "${confirmDelete?.name}"?`}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            This will permanently delete the club and remove all members. This cannot be undone.
          </p>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Reason (optional)</label>
            <input
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Rule violation, spam, etc."
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400 bg-white"
            />
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setConfirmDelete(null); setDeleteReason(''); }}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={deleteClub}>
              Delete Club
            </Button>
          </div>
        </div>
      </Modal>
      )}
    </div>
  );
}
