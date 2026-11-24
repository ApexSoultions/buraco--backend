'use client';
import { useState } from 'react';
import { History, Pencil, Plus } from 'lucide-react';
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
import { errorText, RequireRole } from '@/lib/admin';

interface ShopItem {
  id: string; name: string; description: string | null; category: string;
  priceCoins: number | null; priceDiamonds: number | null;
  isActive: boolean; isConsumable: boolean; sortOrder: number; ownedBy: number;
}
interface PriceRow {
  id: string; name: string;
  currentCoins: number | null; currentDiamonds: number | null;
  backupCoins: number | null; backupDiamonds: number | null;
}

const CATS = ['HOME', 'SUBSCRIPTIONS', 'COINS', 'EMOJIS', 'TABLES', 'CARDS', 'SPECIAL', 'REDEEM', 'LIVES'];
const NEW_ITEM = { name: '', category: 'CARDS', priceCoins: '', priceDiamonds: '', isConsumable: false, description: '' };
const F = 'block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white';
const n = (v: number | null) => (v == null ? '—' : v.toLocaleString());

export default function ShopPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Shop /></RequireRole>;
}

function Shop() {
  const [cat, setCat] = useState('ALL');
  const [editing, setEditing] = useState<ShopItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const items = useFetch<ShopItem[]>('/admin/economy/items', cat === 'ALL' ? {} : { category: cat });
  const backup = useFetch<{ available: boolean; differing: PriceRow[] }>('/admin/economy/price-backup');
  const list = items.data ?? [];
  const differing = backup.data?.available ? backup.data.differing : [];

  function refresh() { items.refetch(); backup.refetch(); }

  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Shop</h1>
          <p className="text-sm text-slate-500 mt-0.5">Items, prices and what is on sale. Changes show in the game at once.</p>
        </div>
        <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>New item</Button>
      </div>

      {differing.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div>
            <p className="text-sm font-medium text-amber-900">{differing.length} item{differing.length === 1 ? '' : 's'} not at the saved real price</p>
            <p className="text-xs text-amber-800 mt-0.5">Prices were lowered for testing. Restore them when testing is finished.</p>
          </div>
          <Button variant="outline" icon={<History size={14} />} onClick={() => setRestoring(true)}>Restore real prices</Button>
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-white border border-slate-200 rounded-xl p-1 overflow-x-auto">
        {['ALL', ...CATS].map((c) => (
          <button key={c} onClick={() => setCat(c)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${cat === c ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            {c === 'ALL' ? 'All' : c.charAt(0) + c.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {items.loading ? (
          <TableSkeleton rows={6} cols={7} />
        ) : list.length === 0 ? (
          <Empty message="No shop items here." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                {['Name', 'Category', 'Coins', 'Diamonds', 'Owned by', 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {list.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-900">{item.name}</td>
                  <td className="px-4 py-3"><Badge variant="blue">{item.category}</Badge></td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">{n(item.priceCoins)}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">{n(item.priceDiamonds)}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-500">{item.ownedBy.toLocaleString()}</td>
                  <td className="px-4 py-3"><Badge variant={item.isActive ? 'green' : 'gray'}>{item.isActive ? 'On sale' : 'Hidden'}</Badge></td>
                  <td className="px-4 py-3">
                    <button onClick={() => setEditing(item)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline">
                      <Pencil size={12} /> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && <EditItem item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {creating && <NewItem onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />}
      {restoring && <RestorePrices rows={differing} onClose={() => setRestoring(false)} onDone={() => { setRestoring(false); refresh(); }} />}
    </div>
  );
}

function EditItem({ item, onClose, onSaved }: { item: ShopItem; onClose(): void; onSaved(): void }) {
  const [form, setForm] = useState({
    name: item.name,
    description: item.description ?? '',
    priceCoins: item.priceCoins?.toString() ?? '',
    priceDiamonds: item.priceDiamonds?.toString() ?? '',
    sortOrder: item.sortOrder.toString(),
    isActive: item.isActive,
  });
  const m = useMutation();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/economy/items/${item.id}`, {
      name: form.name.trim(),
      description: form.description.trim(),
      // Blank = this price is removed (the item is then not sold for that currency).
      priceCoins: form.priceCoins === '' ? null : parseInt(form.priceCoins, 10),
      priceDiamonds: form.priceDiamonds === '' ? null : parseInt(form.priceDiamonds, 10),
      sortOrder: form.sortOrder === '' ? 0 : parseInt(form.sortOrder, 10),
      isActive: form.isActive,
    }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(`"${form.name.trim()}" saved.`); onSaved(); }
    else toast.error(errorText(err, 'Could not save.'));
  }

  return (
    <Modal title={`Edit ${item.name}`} description={`${item.category} · owned by ${item.ownedBy.toLocaleString()} players`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Coins price" type="number" min="0" max="100000000" value={form.priceCoins} placeholder="none" onChange={(e) => setForm({ ...form, priceCoins: e.target.value })} />
          <Input label="Diamonds price" type="number" min="0" max="100000000" value={form.priceDiamonds} placeholder="none" onChange={(e) => setForm({ ...form, priceDiamonds: e.target.value })} />
        </div>
        <Input label="Order in shop (lower first)" type="number" min="0" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="rounded" />
          On sale (untick to hide it from the shop)
        </label>
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={m.loading}>Save</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewItem({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const [form, setForm] = useState(NEW_ITEM);
  const m = useMutation();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    let err: unknown;
    const ok = await m.run(() => api.post('/admin/shop/items', {
      name: form.name.trim(), category: form.category,
      description: form.description.trim() || undefined,
      priceCoins: form.priceCoins ? parseInt(form.priceCoins, 10) : undefined,
      priceDiamonds: form.priceDiamonds ? parseInt(form.priceDiamonds, 10) : undefined,
      isConsumable: form.isConsumable,
    }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success('Item created.'); onSaved(); }
    else toast.error(errorText(err, 'Could not create the item.'));
  }

  return (
    <Modal title="New shop item" onClose={onClose}>
      <form onSubmit={create} className="space-y-3">
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Item name" className={F} />
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" className={F} />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={F}>
          {CATS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input type="number" min="0" value={form.priceCoins} onChange={(e) => setForm({ ...form, priceCoins: e.target.value })} placeholder="Coins price" className={F} />
          <input type="number" min="0" value={form.priceDiamonds} onChange={(e) => setForm({ ...form, priceDiamonds: e.target.value })} placeholder="Diamonds price" className={F} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={form.isConsumable} onChange={(e) => setForm({ ...form, isConsumable: e.target.checked })} className="rounded" />
          Consumable item
        </label>
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={m.loading}>Create</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function RestorePrices({ rows, onClose, onDone }: { rows: PriceRow[]; onClose(): void; onDone(): void }) {
  const m = useMutation();

  async function restore() {
    let err: unknown;
    const ok = await m.run(() => api.post('/admin/economy/price-backup/restore').catch((x) => { err = x; throw x; }));
    if (ok) { toast.success('Real prices restored.'); onDone(); }
    else toast.error(errorText(err, 'Could not restore the prices.'));
  }

  return (
    <Modal title="Restore real prices" description="Every item below goes back to its saved price." onClose={onClose} size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={m.loading} onClick={restore}>Restore {rows.length} price{rows.length === 1 ? '' : 's'}</Button>
      </>}>
      <div className="max-h-72 overflow-y-auto -mx-1 px-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1.5 font-semibold">Item</th><th className="py-1.5 font-semibold">Now</th><th className="py-1.5 font-semibold">Real price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 text-slate-900">{r.name}</td>
                <td className="py-1.5 tabular-nums text-slate-500">{n(r.currentCoins)} coins · {n(r.currentDiamonds)} 💎</td>
                <td className="py-1.5 tabular-nums text-slate-900">{n(r.backupCoins)} coins · {n(r.backupDiamonds)} 💎</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
