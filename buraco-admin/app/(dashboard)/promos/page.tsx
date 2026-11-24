'use client';
import { useState } from 'react';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch, usePaginated } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { errorCode, errorText, RequireRole } from '@/lib/admin';
import { when } from '@/components/players/bits';

interface Promo {
  id: string; code: string;
  rewardCoins: number; rewardDiamonds: number;
  maxUses: number | null; usedCount: number;
  isActive: boolean; expiresAt: string | null;
}

const NEW_PROMO = { code: '', rewardCoins: '', rewardDiamonds: '', maxUses: '', expiresAt: '' };

export default function PromosPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Promos /></RequireRole>;
}

function Promos() {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Promo | null>(null);
  const [viewing, setViewing] = useState<Promo | null>(null);
  const [deleting, setDeleting] = useState<Promo | null>(null);
  const { items: promos, totalPages, loading, refetch } = usePaginated<Promo>('/admin/promos', { page, limit: 20 });

  const expired = (p: Promo) => !!p.expiresAt && new Date(p.expiresAt) < new Date();
  const full = (p: Promo) => p.maxUses != null && p.usedCount >= p.maxUses;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Promo codes</h1>
          <p className="text-sm text-slate-500 mt-0.5">Codes players type into Redeem Code for coins or diamonds. Each player can use a code once.</p>
        </div>
        <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>New code</Button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={6} cols={7} />
        ) : promos.length === 0 ? (
          <Empty message="No promo codes yet." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Code', 'Coins', 'Diamonds', 'Used', 'Expires', 'Status', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {promos.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3 font-mono font-semibold text-slate-900">{p.code}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{p.rewardCoins.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{p.rewardDiamonds.toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-600 tabular-nums">{p.usedCount} / {p.maxUses ?? '∞'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">{p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : '—'}</td>
                    <td className="px-4 py-3">
                      {!p.isActive ? <Badge variant="gray">Off</Badge>
                        : expired(p) ? <Badge variant="red">Expired</Badge>
                        : full(p) ? <Badge variant="yellow">Used up</Badge>
                        : <Badge variant="green">Active</Badge>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-3 text-xs font-medium">
                        <button onClick={() => setViewing(p)} className="inline-flex items-center gap-1 text-slate-600 hover:underline"><Users size={12} /> Used by</button>
                        <button onClick={() => setEditing(p)} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Pencil size={12} /> Edit</button>
                        {p.usedCount === 0 && (
                          <button onClick={() => setDeleting(p)} className="inline-flex items-center gap-1 text-red-500 hover:underline"><Trash2 size={12} /> Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3"><Pagination page={page} totalPages={totalPages} onChange={setPage} /></div>
          </>
        )}
      </div>

      {creating && <NewPromo onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refetch(); }} />}
      {editing && <EditPromo promo={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); }} />}
      {viewing && <Redemptions promo={viewing} onClose={() => setViewing(null)} />}
      {deleting && <DeletePromo promo={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); refetch(); }} />}
    </div>
  );
}

function NewPromo({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const [form, setForm] = useState(NEW_PROMO);
  const m = useMutation();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    let err: unknown;
    const ok = await m.run(() => api.post('/admin/promos', {
      code: form.code.trim().toUpperCase(),
      rewardCoins: form.rewardCoins ? parseInt(form.rewardCoins, 10) : 0,
      rewardDiamonds: form.rewardDiamonds ? parseInt(form.rewardDiamonds, 10) : 0,
      maxUses: form.maxUses ? parseInt(form.maxUses, 10) : undefined,
      expiresAt: form.expiresAt || undefined,
    }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success('Promo code created.'); onSaved(); }
    else toast.error(errorText(err, 'Could not create the code.'));
  }

  return (
    <Modal title="New promo code" onClose={onClose} size="sm">
      <form onSubmit={create} className="space-y-3">
        <Input label="Code (at least 4 characters)" required minLength={4} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="WELCOME50" className="font-mono" />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Coins" type="number" min="0" value={form.rewardCoins} onChange={(e) => setForm({ ...form, rewardCoins: e.target.value })} />
          <Input label="Diamonds" type="number" min="0" value={form.rewardDiamonds} onChange={(e) => setForm({ ...form, rewardDiamonds: e.target.value })} />
        </div>
        <Input label="Max uses (blank = unlimited)" type="number" min="1" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
        <Input label="Expires (blank = never)" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={m.loading}>Create</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditPromo({ promo, onClose, onSaved }: { promo: Promo; onClose(): void; onSaved(): void }) {
  const [form, setForm] = useState({
    rewardCoins: promo.rewardCoins.toString(),
    rewardDiamonds: promo.rewardDiamonds.toString(),
    maxUses: promo.maxUses?.toString() ?? '',
    expiresAt: promo.expiresAt ? promo.expiresAt.slice(0, 10) : '',
    isActive: promo.isActive,
  });
  const m = useMutation();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/economy/promos/${promo.id}`, {
      rewardCoins: form.rewardCoins ? parseInt(form.rewardCoins, 10) : 0,
      rewardDiamonds: form.rewardDiamonds ? parseInt(form.rewardDiamonds, 10) : 0,
      maxUses: form.maxUses ? parseInt(form.maxUses, 10) : null,
      expiresAt: form.expiresAt || null,
      isActive: form.isActive,
    }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(`${promo.code} saved.`); onSaved(); }
    else if (errorCode(err) === 'MAX_USES_BELOW_USED') toast.error(`The limit can't be lower than the ${promo.usedCount} uses so far.`);
    else toast.error(errorText(err, 'Could not save.'));
  }

  return (
    <Modal title={`Edit ${promo.code}`} description="The code itself can't change; make a new one instead." onClose={onClose} size="sm">
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label="Coins" type="number" min="0" value={form.rewardCoins} onChange={(e) => setForm({ ...form, rewardCoins: e.target.value })} />
          <Input label="Diamonds" type="number" min="0" value={form.rewardDiamonds} onChange={(e) => setForm({ ...form, rewardDiamonds: e.target.value })} />
        </div>
        <Input label={`Max uses (used so far: ${promo.usedCount}; blank = unlimited)`} type="number" min={Math.max(1, promo.usedCount)} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
        <Input label="Expires (blank = never)" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="rounded" />
          Active (untick to stop players using it)
        </label>
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={m.loading}>Save</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function Redemptions({ promo, onClose }: { promo: Promo; onClose(): void }) {
  const { data, loading } = useFetch<{ redemptions: { id: string; redeemedAt: string; user: { id: string; username: string } }[] }>(`/admin/economy/promos/${promo.id}/redemptions`);
  const rows = data?.redemptions ?? [];
  return (
    <Modal title={`Who used ${promo.code}`} description={`${promo.usedCount} use${promo.usedCount === 1 ? '' : 's'} so far`} onClose={onClose}>
      {loading ? <p className="text-sm text-slate-400">Loading…</p>
        : rows.length === 0 ? <p className="text-sm text-slate-500">Nobody has used this code yet.</p>
        : (
          <ul className="max-h-72 overflow-y-auto divide-y divide-slate-100 text-sm">
            {rows.map((r) => (
              <li key={r.id} className="py-2 flex justify-between gap-3">
                <a href={`/users/${r.user.id}`} className="font-medium text-blue-600 hover:underline">{r.user.username}</a>
                <span className="text-xs text-slate-400">{when(r.redeemedAt)}</span>
              </li>
            ))}
          </ul>
        )}
    </Modal>
  );
}

function DeletePromo({ promo, onClose, onDone }: { promo: Promo; onClose(): void; onDone(): void }) {
  const m = useMutation();
  async function remove() {
    let err: unknown;
    const ok = await m.run(() => api.delete(`/admin/economy/promos/${promo.id}`).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(`${promo.code} deleted.`); onDone(); }
    else toast.error(errorCode(err) === 'PROMO_ALREADY_USED' ? 'Someone has used it; switch it off instead.' : errorText(err, 'Could not delete.'));
  }
  return (
    <Modal title={`Delete ${promo.code}?`} description="Nobody has used it. This can't be undone." onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={remove}>Delete</Button></>}>
      <p className="text-sm text-slate-600">To keep a code but stop players using it, use Edit and untick Active instead.</p>
    </Modal>
  );
}
