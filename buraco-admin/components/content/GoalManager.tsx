'use client';
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { errorCode, errorText } from '@/lib/admin';

export const REQ_LABEL: Record<string, string> = {
  PLAY_GAMES: 'Play games', WIN_GAMES: 'Win games', EARN_POINTS: 'Earn points',
  SEND_MESSAGES: 'Send messages', JOIN_CLUB: 'Join a club', PLAY_CLASSIC: 'Play Classic games',
  PLAY_PROFESSIONAL: 'Play Professional games', WIN_STREAK: 'Win in a row',
};

export interface Goal {
  id: string; title: string; description: string; requirement: string; targetValue: number;
  mode: 'CLASSIC' | 'PROFESSIONAL' | null; sortOrder: number; isActive: boolean;
  [key: string]: unknown;
}

interface Props {
  /** "achievements" or "objectives" (under /admin/content). */
  endpoint: string;
  title: string;
  intro: string;
  /** Singular name for messages: "achievement", "clan objective". */
  noun: string;
  /** The reward numbers of this kind. */
  rewards: { key: string; label: string }[];
  /** What the table counts: e.g. "Completed by" with a function reading the row. */
  stats: { label: string; value(g: Goal): string }[];
}

type Form = {
  title: string; description: string; requirement: string; targetValue: string;
  mode: string; sortOrder: string; isActive: boolean; rewards: Record<string, string>;
};

const F = 'block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white';

export default function GoalManager({ endpoint, title, intro, noun, rewards, stats }: Props) {
  const { data, loading, refetch } = useFetch<Goal[]>(`/admin/content/${endpoint}`);
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const toggleM = useMutation();
  const list = data ?? [];

  async function toggle(g: Goal) {
    let err: unknown;
    const ok = await toggleM.run(() => api.patch(`/admin/content/${endpoint}/${g.id}`, { isActive: !g.isActive }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`"${g.title}" ${g.isActive ? 'switched off' : 'switched on'}.`); refetch(); }
    else toast.error(errorText(err, 'Could not change it.'));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">{intro}</p>
        </div>
        <Button icon={<Plus size={14} />} onClick={() => setEditing('new')}>New</Button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={6} cols={6} /> : list.length === 0 ? <Empty message={`No ${noun}s yet.`} /> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                {['Title', 'Goal', ...rewards.map((r) => r.label), ...stats.map((s) => s.label), 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {list.map((g) => (
                <tr key={g.id} className={`hover:bg-slate-50/60 ${g.isActive ? '' : 'opacity-60'}`}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{g.title}</p>
                    <p className="text-xs text-slate-400 max-w-xs truncate">{g.description}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                    {REQ_LABEL[g.requirement] ?? g.requirement}: <span className="tabular-nums font-medium">{g.targetValue.toLocaleString()}</span>
                    {g.mode && <span className="ml-1.5"><Badge variant="purple">{g.mode === 'CLASSIC' ? 'Classic' : 'Professional'}</Badge></span>}
                  </td>
                  {rewards.map((r) => <td key={r.key} className="px-4 py-3 tabular-nums text-slate-700">{Number(g[r.key] ?? 0).toLocaleString()}</td>)}
                  {stats.map((s) => <td key={s.label} className="px-4 py-3 tabular-nums text-slate-500 whitespace-nowrap">{s.value(g)}</td>)}
                  <td className="px-4 py-3"><Badge variant={g.isActive ? 'green' : 'gray'}>{g.isActive ? 'On' : 'Off'}</Badge></td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-3 text-xs font-medium">
                      <button onClick={() => setEditing(g)} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Pencil size={12} /> Edit</button>
                      <button onClick={() => toggle(g)} disabled={toggleM.loading} className={`hover:underline disabled:opacity-40 ${g.isActive ? 'text-slate-500' : 'text-emerald-600'}`}>{g.isActive ? 'Switch off' : 'Switch on'}</button>
                      <button onClick={() => setDeleting(g)} className="inline-flex items-center gap-1 text-red-500 hover:underline"><Trash2 size={12} /> Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <GoalForm endpoint={endpoint} noun={noun} rewards={rewards} goal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); }} />
      )}
      {deleting && (
        <DeleteGoal endpoint={endpoint} goal={deleting} noun={noun} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); refetch(); }} />
      )}
    </div>
  );
}

function GoalForm({ endpoint, noun, rewards, goal, onClose, onSaved }: {
  endpoint: string; noun: string; rewards: Props['rewards']; goal: Goal | null; onClose(): void; onSaved(): void;
}) {
  const [form, setForm] = useState<Form>({
    title: goal?.title ?? '',
    description: goal?.description ?? '',
    requirement: goal?.requirement ?? 'PLAY_GAMES',
    targetValue: goal ? String(goal.targetValue) : '10',
    mode: goal?.mode ?? '',
    sortOrder: goal ? String(goal.sortOrder) : '0',
    isActive: goal?.isActive ?? true,
    rewards: Object.fromEntries(rewards.map((r) => [r.key, String(goal?.[r.key] ?? 0)])),
  });
  const m = useMutation();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      requirement: form.requirement,
      targetValue: parseInt(form.targetValue, 10),
      mode: form.mode || null,
      sortOrder: parseInt(form.sortOrder || '0', 10),
      isActive: form.isActive,
      ...Object.fromEntries(rewards.map((r) => [r.key, parseInt(form.rewards[r.key] || '0', 10)])),
    };
    let err: unknown;
    const ok = await m.run(() => (goal
      ? api.patch(`/admin/content/${endpoint}/${goal.id}`, body)
      : api.post(`/admin/content/${endpoint}`, body)).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(goal ? 'Saved.' : `New ${noun} created.`); onSaved(); }
    else toast.error(errorText(err, 'Could not save.'));
  }

  return (
    <Modal title={goal ? `Edit ${noun}` : `New ${noun}`} onClose={onClose} size="lg">
      <form onSubmit={save} className="space-y-3">
        <Input label="Title (what players see)" required minLength={2} maxLength={80} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <Input label="Description" required minLength={2} maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Counts</label>
            <select value={form.requirement} onChange={(e) => setForm({ ...form, requirement: e.target.value })} className={F}>
              {Object.entries(REQ_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <Input label="Target" type="number" required min="1" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Game mode</label>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} className={F}>
              <option value="">Any mode</option>
              <option value="CLASSIC">Classic only</option>
              <option value="PROFESSIONAL">Professional only</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {rewards.map((r) => (
            <Input key={r.key} label={`Reward: ${r.label.toLowerCase()}`} type="number" min="0" value={form.rewards[r.key]}
              onChange={(e) => setForm({ ...form, rewards: { ...form.rewards, [r.key]: e.target.value } })} />
          ))}
          <Input label="Order (lower first)" type="number" min="0" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="rounded" />
          On (players can see and progress it)
        </label>
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={m.loading}>{goal ? 'Save' : 'Create'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteGoal({ endpoint, goal, noun, onClose, onDone }: { endpoint: string; goal: Goal; noun: string; onClose(): void; onDone(): void }) {
  const m = useMutation();
  async function remove() {
    let err: unknown;
    const ok = await m.run(() => api.delete(`/admin/content/${endpoint}/${goal.id}`).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(`"${goal.title}" deleted.`); onDone(); }
    else if (/HAS_PROGRESS/.test(errorCode(err))) toast.error('Players already have progress on it. Switch it off instead.');
    else toast.error(errorText(err, 'Could not delete.'));
  }
  return (
    <Modal title={`Delete "${goal.title}"?`} description="This can't be undone." onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={remove}>Delete</Button></>}>
      <p className="text-sm text-slate-600">If players already made progress on this {noun}, it can&apos;t be deleted; switch it off instead and it disappears from the game.</p>
    </Modal>
  );
}
