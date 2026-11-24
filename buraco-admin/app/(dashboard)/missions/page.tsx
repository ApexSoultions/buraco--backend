'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Pencil, Trash2, Plus } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface Mission {
  id: string;
  title: string;
  description: string;
  type: 'DAILY' | 'WEEKLY';
  requirement: string;
  targetValue: number;
  rewardCoins: number;
  rewardDiamonds: number;
  isActive: boolean;
}

const REQUIREMENTS = [
  'PLAY_GAMES', 'WIN_GAMES', 'EARN_POINTS', 'SEND_MESSAGES',
  'JOIN_CLUB', 'PLAY_CLASSIC', 'PLAY_PROFESSIONAL', 'WIN_STREAK',
];

const REQ_LABEL: Record<string, string> = {
  PLAY_GAMES: 'Play Games', WIN_GAMES: 'Win Games', EARN_POINTS: 'Earn Points',
  SEND_MESSAGES: 'Send Messages', JOIN_CLUB: 'Join Club', PLAY_CLASSIC: 'Play Classic',
  PLAY_PROFESSIONAL: 'Play Professional', WIN_STREAK: 'Win Streak',
};

const EMPTY_FORM = {
  title: '', description: '', type: 'DAILY' as 'DAILY' | 'WEEKLY',
  requirement: 'PLAY_GAMES', targetValue: 1, rewardCoins: 0, rewardDiamonds: 0,
};

export default function MissionsPage() {
  const { data, loading, refetch } = useFetch<Mission[]>('/admin/missions');
  const missions = data ?? [];
  const { run, loading: saving } = useMutation();

  const [togglingId, setTogglingId]   = useState<string | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);
  const [showCreate, setShowCreate]   = useState(false);
  const [editTarget, setEditTarget]   = useState<Mission | null>(null);
  const [confirmDel, setConfirmDel]   = useState<Mission | null>(null);
  const [form, setForm]               = useState({ ...EMPTY_FORM });

  const daily  = missions.filter((m) => m.type === 'DAILY');
  const weekly = missions.filter((m) => m.type === 'WEEKLY');

  function openCreate() { setForm({ ...EMPTY_FORM }); setShowCreate(true); }
  function openEdit(m: Mission) {
    setForm({
      title: m.title, description: m.description, type: m.type,
      requirement: m.requirement, targetValue: m.targetValue,
      rewardCoins: m.rewardCoins, rewardDiamonds: m.rewardDiamonds,
    });
    setEditTarget(m);
  }

  function field(key: keyof typeof EMPTY_FORM, value: string | number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submitCreate() {
    const ok = await run(() => api.post('/admin/missions', { ...form, targetValue: +form.targetValue, rewardCoins: +form.rewardCoins, rewardDiamonds: +form.rewardDiamonds }));
    if (ok) { toast.success('Mission created'); setShowCreate(false); refetch(); }
    else toast.error('Failed to create mission');
  }

  async function submitEdit() {
    if (!editTarget) return;
    const ok = await run(() => api.patch(`/admin/missions/${editTarget.id}`, { ...form, targetValue: +form.targetValue, rewardCoins: +form.rewardCoins, rewardDiamonds: +form.rewardDiamonds }));
    if (ok) { toast.success('Mission updated'); setEditTarget(null); refetch(); }
    else toast.error('Failed to update mission');
  }

  async function toggle(m: Mission) {
    setTogglingId(m.id);
    const ok = await run(() => api.patch(`/admin/missions/${m.id}/toggle`, { isActive: !m.isActive }));
    setTogglingId(null);
    if (ok) { toast.success(`"${m.title}" ${m.isActive ? 'deactivated' : 'activated'}`); refetch(); }
    else toast.error('Failed to update mission');
  }

  async function confirmDelete() {
    if (!confirmDel) return;
    setDeletingId(confirmDel.id);
    const ok = await run(() => api.delete(`/admin/missions/${confirmDel.id}`));
    setDeletingId(null);
    if (ok) { toast.success(`"${confirmDel.title}" deleted`); setConfirmDel(null); refetch(); }
    else toast.error('Failed to delete mission');
  }

  function MissionForm() {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Type</label>
            <select value={form.type} onChange={(e) => field('type', e.target.value as 'DAILY' | 'WEEKLY')}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Requirement</label>
            <select value={form.requirement} onChange={(e) => field('requirement', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
              {REQUIREMENTS.map((r) => <option key={r} value={r}>{REQ_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1">Title</label>
          <input value={form.title} onChange={(e) => field('title', e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. Play 5 Games" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1">Description</label>
          <input value={form.description} onChange={(e) => field('description', e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder="Short description shown to players" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Target</label>
            <input type="number" min={1} value={form.targetValue} onChange={(e) => field('targetValue', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Coins reward</label>
            <input type="number" min={0} value={form.rewardCoins} onChange={(e) => field('rewardCoins', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Diamonds reward</label>
            <input type="number" min={0} value={form.rewardDiamonds} onChange={(e) => field('rewardDiamonds', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>
      </div>
    );
  }

  function MissionTable({ items }: { items: Mission[] }) {
    if (items.length === 0) return <Empty message="No missions in this group." />;
    return (
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-100">
          <tr>
            {['Mission', 'Requirement', 'Target', 'Rewards', 'Status', ''].map((h) => (
              <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {items.map((m) => (
            <tr key={m.id} className="hover:bg-slate-50/60 transition-colors">
              <td className="px-4 py-3">
                <p className="font-medium text-slate-800">{m.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{m.description}</p>
              </td>
              <td className="px-4 py-3">
                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">
                  {REQ_LABEL[m.requirement] ?? m.requirement}
                </span>
              </td>
              <td className="px-4 py-3 text-slate-700 font-semibold">{m.targetValue}</td>
              <td className="px-4 py-3">
                {m.rewardCoins > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full mr-1">
                    🪙 {m.rewardCoins}
                  </span>
                )}
                {m.rewardDiamonds > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full">
                    💎 {m.rewardDiamonds}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <Badge variant={m.isActive ? 'green' : 'gray'}>{m.isActive ? 'Active' : 'Inactive'}</Badge>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-3">
                  <button onClick={() => toggle(m)} disabled={togglingId === m.id}
                    className={`text-xs font-semibold hover:underline disabled:opacity-50 ${m.isActive ? 'text-red-500' : 'text-green-600'}`}>
                    {togglingId === m.id ? '…' : m.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => openEdit(m)} className="text-slate-400 hover:text-blue-600 transition-colors">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setConfirmDel(m)} className="text-slate-400 hover:text-red-500 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Missions</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage daily and weekly player missions</p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus size={14} className="mr-1" /> New Mission
        </Button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <TableSkeleton rows={10} cols={6} />
        </div>
      ) : missions.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <Empty message="No missions found. Run the seed or create one above." />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Daily Missions</h2>
              <span className="text-xs text-slate-400">({daily.filter((m) => m.isActive).length} active / {daily.length} total)</span>
            </div>
            <MissionTable items={daily} />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Weekly Missions</h2>
              <span className="text-xs text-slate-400">({weekly.filter((m) => m.isActive).length} active / {weekly.length} total)</span>
            </div>
            <MissionTable items={weekly} />
          </div>
        </div>
      )}

      {showCreate && (
        <Modal title="New Mission" onClose={() => setShowCreate(false)}>
          {MissionForm()}
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={submitCreate} loading={saving} disabled={!form.title || !form.description}>Create</Button>
          </div>
        </Modal>
      )}

      {!!editTarget && (
        <Modal title="Edit Mission" onClose={() => setEditTarget(null)}>
          {MissionForm()}
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={submitEdit} loading={saving} disabled={!form.title || !form.description}>Save Changes</Button>
          </div>
        </Modal>
      )}

      {!!confirmDel && (
        <Modal title="Delete Mission" onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-600">
            Are you sure you want to delete <span className="font-semibold text-slate-800">"{confirmDel?.title}"</span>?
            This will also remove all player progress for this mission.
          </p>
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="outline" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button onClick={confirmDelete} loading={!!deletingId}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600">
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
