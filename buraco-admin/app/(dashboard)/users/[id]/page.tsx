'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import toast from 'react-hot-toast';
import {
  ArrowLeft, Ban, Coins, Gem, Heart, Gift, PencilLine, ShieldCheck, Trophy, Flag, Eraser, Shield,
} from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { errorCode, errorText, useAdmin } from '@/lib/admin';
import { PlanBadge, ago, when } from '@/components/players/bits';
import Avatar from '@/components/players/Avatar';

interface Player {
  id: string; username: string; email: string | null; avatarUrl: string | null; country: string | null;
  coins: number; diamonds: number; lives: number;
  subscriptionStatus: string; subscriptionExpiry: string | null; voiceChatExpiry: string | null;
  isBanned: boolean; banReason: string | null; isDeleted: boolean;
  createdAt: string; lastSeenAt: string | null;
  login: { email: boolean; google: boolean; apple: boolean };
  stats: { level: number; points: number; gamesPlayed: number; gamesWon?: number; winPercentage: number; winStreak: number; bestWinStreak: number } | null;
  club: { id: string; name: string; role: string; points: number } | null;
  inventory: Array<{ id: string; quantity: number; isEquipped: boolean; purchasedAt: string; item: { id: string; name: string; category: string } }>;
  gamePlayers: Array<{ teamId: number; finalScore: number | null; result: string | null; game: { id: string; mode: string; variant: string; status: string; createdAt: string } }>;
  transactions: Array<{ id: string; type: string; currency: string; amount: number; balanceAfter: number; description: string | null; createdAt: string }>;
  iapPurchases: Array<{ id: string; store: string; productId: string; coins: number; environment: string | null; createdAt: string }>;
  notes: Array<{ id: string; content: string; by: string; createdAt: string }>;
  reports: { received: number; open: number; made: number };
  customCards: number;
}

const TABS = ['Overview', 'Matches', 'History', 'Purchases', 'Notes'] as const;
type Tab = typeof TABS[number];
type Action = 'coins' | 'lives' | 'item' | 'ban' | 'name' | 'edit' | null;

const ERRORS: Record<string, string> = {
  INSUFFICIENT_BALANCE: "The player doesn't have that much.",
  NOT_ENOUGH_LIVES: "The player doesn't have that many lives.",
  USERNAME_TAKEN: 'That name is already used by another player.',
  EMAIL_TAKEN: 'That email is already used by another player.',
};
const fail = (e: unknown, what: string) => toast.error(ERRORS[errorCode(e)] ?? errorText(e, what));

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAdmin();
  const { data: p, loading, refetch } = useFetch<Player>(`/admin/users/${id}`);
  const [tab, setTab] = useState<Tab>('Overview');
  const [action, setAction] = useState<Action>(null);

  if (loading && !p) {
    return <div className="space-y-4 animate-pulse"><div className="h-20 bg-white rounded-xl" /><div className="h-48 bg-white rounded-xl" /></div>;
  }
  if (!p) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500 mb-4">Player not found.</p>
        <Link href="/users" className="text-blue-600 hover:underline text-sm">← Back to players</Link>
      </div>
    );
  }

  const SUPER = can(['SUPER_ADMIN']);
  const STAFF = can(['SUPER_ADMIN', 'MODERATOR']);
  const done = () => { setAction(null); refetch(); };
  const logins = [p.login.email && 'Email', p.login.google && 'Google', p.login.apple && 'Apple'].filter(Boolean).join(', ') || '—';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <button onClick={() => router.back()} className="p-1.5 -ml-1 rounded-lg hover:bg-slate-100 text-slate-500" aria-label="Back"><ArrowLeft size={18} /></button>
          <Avatar url={p.avatarUrl} name={p.username} />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg sm:text-xl font-semibold text-slate-900 break-all">{p.username}</h1>
              <Badge variant={p.isBanned ? 'red' : 'green'}>{p.isBanned ? 'Banned' : 'Active'}</Badge>
              <PlanBadge status={p.subscriptionStatus} />
              {p.isDeleted && <Badge variant="gray">Deleted account</Badge>}
            </div>
            <p className="text-sm text-slate-500 break-all">{p.email ?? 'No email'} · logs in with {logins}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Joined {new Date(p.createdAt).toLocaleDateString()} · seen {ago(p.lastSeenAt)}{p.country ? ` · ${p.country}` : ''}
            </p>
          </div>
        </div>
        {p.isBanned && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            Banned{p.banReason ? `: ${p.banReason}` : ''}
          </p>
        )}
      </div>

      {/* Numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Num Icon={Coins} label="Coins" value={p.coins.toLocaleString()} />
        <Num Icon={Gem} label="Diamonds" value={p.diamonds.toLocaleString()} />
        <Num Icon={Heart} label="Lives" value={p.lives} />
        <Num Icon={Trophy} label="Level · points" value={p.stats ? `${p.stats.level} · ${p.stats.points.toLocaleString()}` : '—'} />
        <Num Icon={ShieldCheck} label="Matches · wins" value={p.stats ? `${p.stats.gamesPlayed} · ${p.stats.winPercentage.toFixed(0)}%` : '—'} />
        <Num Icon={Flag} label="Reports (open)" value={`${p.reports.received} (${p.reports.open})`} warn={p.reports.open > 0} />
      </div>

      {/* Actions, by role */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Actions</h2>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
          {SUPER && <Button variant="outline" icon={<Coins size={15} />} onClick={() => setAction('coins')}>Coins / diamonds</Button>}
          {SUPER && <Button variant="outline" icon={<Heart size={15} />} onClick={() => setAction('lives')}>Lives</Button>}
          {SUPER && <Button variant="outline" icon={<Gift size={15} />} onClick={() => setAction('item')}>Send an item</Button>}
          {SUPER && <Button variant="outline" icon={<PencilLine size={15} />} onClick={() => setAction('edit')}>Edit profile</Button>}
          {STAFF && <Button variant="outline" icon={<Eraser size={15} />} onClick={() => setAction('name')}>Reset name</Button>}
          {STAFF && (p.isBanned
            ? <Button variant="success" icon={<ShieldCheck size={15} />} onClick={() => setAction('ban')}>Unban</Button>
            : <Button variant="danger" icon={<Ban size={15} />} onClick={() => setAction('ban')}>Ban</Button>)}
        </div>
        {!STAFF && <p className="text-xs text-slate-400 mt-2">Your role can look and add notes. Ask a moderator or super admin for changes.</p>}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex border-b border-slate-100 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 sm:px-5 py-3 text-sm font-medium whitespace-nowrap border-b-2 -mb-px
                ${tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              {t}{t === 'Notes' && p.notes.length ? ` (${p.notes.length})` : ''}
            </button>
          ))}
        </div>
        <div className="p-4 sm:p-5">
          {tab === 'Overview' && <Overview p={p} />}
          {tab === 'Matches' && <Matches p={p} />}
          {tab === 'History' && <History p={p} />}
          {tab === 'Purchases' && <Purchases p={p} />}
          {tab === 'Notes' && <Notes p={p} onAdded={refetch} />}
        </div>
      </div>

      {action === 'coins' && <BalanceDialog p={p} onClose={() => setAction(null)} onDone={done} />}
      {action === 'lives' && <LivesDialog p={p} onClose={() => setAction(null)} onDone={done} />}
      {action === 'item' && <ItemDialog p={p} onClose={() => setAction(null)} onDone={done} />}
      {action === 'edit' && <EditDialog p={p} onClose={() => setAction(null)} onDone={done} />}
      {action === 'name' && <ResetNameDialog p={p} onClose={() => setAction(null)} onDone={done} />}
      {action === 'ban' && <BanDialog p={p} onClose={() => setAction(null)} onDone={done} />}
    </div>
  );
}

function Num({ Icon, label, value, warn }: { Icon: typeof Coins; label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border p-3 ${warn ? 'border-red-200' : 'border-slate-200'}`}>
      <p className="text-[11px] text-slate-500 flex items-center gap-1.5 uppercase tracking-wide"><Icon size={12} /> {label}</p>
      <p className={`text-lg font-bold tabular-nums mt-0.5 ${warn ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function Overview({ p }: { p: Player }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <section>
        <H>Clan</H>
        {p.club
          ? <Link href={`/clubs`} className="flex items-center gap-2 text-sm text-slate-800 hover:text-blue-600"><Shield size={15} /> {p.club.name} <span className="text-slate-400">· {p.club.role.toLowerCase()} · {p.club.points} pts</span></Link>
          : <p className="text-sm text-slate-400">Not in a clan.</p>}
        <H className="mt-5">Subscription</H>
        <p className="text-sm text-slate-700"><PlanBadge status={p.subscriptionStatus} />{' '}
          {p.subscriptionExpiry && <span className="text-slate-500">until {new Date(p.subscriptionExpiry).toLocaleDateString()}</span>}
        </p>
        {p.voiceChatExpiry && <p className="text-sm text-slate-500 mt-1">Voice chat until {new Date(p.voiceChatExpiry).toLocaleDateString()}</p>}
        <H className="mt-5">Stats</H>
        {p.stats ? (
          <p className="text-sm text-slate-700">Win streak {p.stats.winStreak} (best {p.stats.bestWinStreak}) · reports sent by this player: {p.reports.made} · custom cards: {p.customCards}</p>
        ) : <p className="text-sm text-slate-400">No matches yet.</p>}
      </section>
      <section>
        <H>Items ({p.inventory.length})</H>
        {p.inventory.length === 0 ? <p className="text-sm text-slate-400">No items.</p> : (
          <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
            {p.inventory.map((i) => (
              <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-slate-800">{i.item.name} <span className="text-slate-400 text-xs">· {i.item.category.toLowerCase().replace(/_/g, ' ')}</span></span>
                <span className="flex items-center gap-2 text-xs text-slate-500">{i.quantity > 1 && `×${i.quantity}`}{i.isEquipped && <Badge variant="green">In use</Badge>}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Matches({ p }: { p: Player }) {
  if (p.gamePlayers.length === 0) return <Empty>No matches yet.</Empty>;
  return (
    <ul className="divide-y divide-slate-100">
      {p.gamePlayers.map((g) => (
        <li key={g.game.id} className="flex items-center justify-between py-2.5 text-sm gap-3">
          <span className="min-w-0">
            <span className="text-slate-800">{g.game.mode.replace(/_/g, ' ').toLowerCase()} · {g.game.variant.toLowerCase()}</span>
            <span className="block text-xs text-slate-400">{when(g.game.createdAt)} · {g.game.status.toLowerCase().replace('_', ' ')}</span>
          </span>
          <span className="shrink-0 flex items-center gap-2">
            {g.finalScore !== null && <span className="tabular-nums text-slate-600">{g.finalScore}</span>}
            {g.result && <Badge variant={g.result === 'WIN' ? 'green' : g.result === 'LOSS' ? 'red' : 'gray'}>{g.result.toLowerCase()}</Badge>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function History({ p }: { p: Player }) {
  if (p.transactions.length === 0) return <Empty>No coin or diamond changes yet.</Empty>;
  return (
    <ul className="divide-y divide-slate-100">
      {p.transactions.map((t) => {
        const plus = t.type === 'MANUAL_DEDUCT' ? false : t.amount >= 0;
        return (
          <li key={t.id} className="flex items-center justify-between py-2.5 text-sm gap-3">
            <span className="min-w-0">
              <span className="text-slate-800">{t.type.replace(/_/g, ' ').toLowerCase()}</span>
              <span className="block text-xs text-slate-400 truncate">{when(t.createdAt)}{t.description ? ` · ${t.description}` : ''}</span>
            </span>
            <span className={`shrink-0 tabular-nums font-semibold ${plus ? 'text-emerald-600' : 'text-red-500'}`}>
              {plus ? '+' : '−'}{Math.abs(t.amount).toLocaleString()} {t.currency.toLowerCase()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Purchases({ p }: { p: Player }) {
  if (p.iapPurchases.length === 0) return <Empty>No store purchases.</Empty>;
  return (
    <ul className="divide-y divide-slate-100">
      {p.iapPurchases.map((i) => (
        <li key={i.id} className="flex items-center justify-between py-2.5 text-sm gap-3">
          <span className="min-w-0">
            <span className="text-slate-800">{i.productId}</span>
            <span className="block text-xs text-slate-400">{when(i.createdAt)} · {i.store === 'FAKE' ? 'editor test' : i.store.replace('_', ' ').toLowerCase()}{i.environment ? ` · ${i.environment}` : ''}</span>
          </span>
          <span className="shrink-0 tabular-nums text-slate-700">+{i.coins.toLocaleString()} coins</span>
        </li>
      ))}
    </ul>
  );
}

function Notes({ p, onAdded }: { p: Player; onAdded(): void }) {
  const [text, setText] = useState('');
  const m = useMutation();
  async function add() {
    if (!text.trim()) return;
    let err: unknown;
    const ok = await m.run(() => api.post(`/admin/users/${p.id}/notes`, { content: text }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success('Note added.'); setText(''); onAdded(); } else fail(err, 'Could not add the note.');
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000}
          placeholder="A note for the staff, e.g. “warned about chat language on 22 Nov”"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none" />
        <Button loading={m.loading} onClick={add} className="sm:self-start">Add note</Button>
      </div>
      {p.notes.length === 0 ? <Empty>No notes yet.</Empty> : (
        <ul className="space-y-2">
          {p.notes.map((n) => (
            <li key={n.id} className="bg-slate-50 rounded-lg px-4 py-3">
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{n.content}</p>
              <p className="text-xs text-slate-400 mt-1">{n.by} · {when(n.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const H = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <h3 className={`text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 ${className}`}>{children}</h3>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-slate-400 text-center py-6">{children}</p>;

// ── Action dialogs ────────────────────────────────────────────────────────────

interface DialogProps { p: Player; onClose(): void; onDone(): void }
const SELECT = 'block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

function BalanceDialog({ p, onClose, onDone }: DialogProps) {
  const [currency, setCurrency] = useState<'COINS' | 'DIAMONDS'>('COINS');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation();
  const n = parseInt(amount, 10);
  async function go(kind: 'credit' | 'deduct') {
    if (!(n > 0)) return toast.error('Enter an amount above 0.');
    let err: unknown;
    const ok = await m.run(() => api.post(`/admin/users/${p.id}/${kind}`, { currency, amount: n, reason: reason || undefined }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`${kind === 'credit' ? 'Gave' : 'Took'} ${n.toLocaleString()} ${currency.toLowerCase()}.`); onDone(); }
    else fail(err, 'Could not change the balance.');
  }
  return (
    <Modal title="Coins / diamonds" description={`${p.username} has ${p.coins.toLocaleString()} coins and ${p.diamonds.toLocaleString()} diamonds.`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={m.loading} onClick={() => go('deduct')}>Take</Button>
        <Button variant="success" loading={m.loading} onClick={() => go('credit')}>Give</Button></>}>
      <div className="space-y-3">
        <select className={SELECT} value={currency} onChange={(e) => setCurrency(e.target.value as 'COINS' | 'DIAMONDS')}>
          <option value="COINS">Coins</option><option value="DIAMONDS">Diamonds</option>
        </select>
        <Input label="Amount" type="number" min={1} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Reason (shown in the player's history)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. refund for a lost match" />
      </div>
    </Modal>
  );
}

function LivesDialog({ p, onClose, onDone }: DialogProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation();
  const n = parseInt(amount, 10);
  async function go(sign: 1 | -1) {
    if (!(n > 0)) return toast.error('Enter a number above 0.');
    let err: unknown;
    const ok = await m.run(() => api.post(`/admin/users/${p.id}/lives`, { amount: sign * n, reason: reason || undefined }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`${sign > 0 ? 'Gave' : 'Took'} ${n} lives.`); onDone(); } else fail(err, 'Could not change lives.');
  }
  return (
    <Modal title="Lives" description={`${p.username} has ${p.lives} lives.`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={m.loading} onClick={() => go(-1)}>Take</Button>
        <Button variant="success" loading={m.loading} onClick={() => go(1)}>Give</Button></>}>
      <div className="space-y-3">
        <Input label="How many lives" type="number" min={1} max={1000} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Reason (for the audit log)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

interface ShopItem { id: string; name: string; category: string; isActive?: boolean }

function ItemDialog({ p, onClose, onDone }: DialogProps) {
  const { data } = useFetch<{ data: ShopItem[] }>('/admin/shop/items', { page: 1, limit: 100 });
  const items = data?.data ?? [];
  const [itemId, setItemId] = useState('');
  const m = useMutation();
  const chosen = itemId || items[0]?.id || '';
  async function send() {
    if (!chosen) return;
    let err: unknown;
    const ok = await m.run(() => api.post(`/admin/users/${p.id}/send-item`, { itemId: chosen }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success('Item sent.'); onDone(); } else fail(err, 'Could not send the item.');
  }
  return (
    <Modal title="Send an item" description={`It goes straight into ${p.username}'s items.`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={m.loading} onClick={send} disabled={!chosen}>Send</Button></>}>
      {items.length === 0 ? <p className="text-sm text-slate-500">Loading shop items…</p> : (
        <select className={SELECT} value={chosen} onChange={(e) => setItemId(e.target.value)}>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.category.toLowerCase().replace(/_/g, ' ')})</option>)}
        </select>
      )}
    </Modal>
  );
}

function EditDialog({ p, onClose, onDone }: DialogProps) {
  const [username, setUsername] = useState(p.username);
  const [email, setEmail] = useState(p.email ?? '');
  const [plan, setPlan] = useState(p.subscriptionStatus);
  const m = useMutation();
  async function save() {
    const body: Record<string, unknown> = {};
    if (username.trim() !== p.username) body.username = username.trim();
    if (email.trim() !== (p.email ?? '') && email.trim()) body.email = email.trim();
    if (plan !== p.subscriptionStatus) body.subscriptionStatus = plan;
    if (!Object.keys(body).length) return onClose();
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/users/${p.id}`, body).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success('Saved.'); onDone(); } else fail(err, 'Could not save.');
  }
  return (
    <Modal title="Edit profile" description="Coins, diamonds and lives are changed with their own buttons." onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={m.loading} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Input label="Name" value={username} maxLength={30} onChange={(e) => setUsername(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Subscription</label>
          <select className={SELECT} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="FREE">Free</option><option value="BASIC">Basic</option><option value="PREMIUM">Premium</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function ResetNameDialog({ p, onClose, onDone }: DialogProps) {
  const m = useMutation();
  async function go() {
    let err: unknown; let name = '';
    const ok = await m.run(() => api.post(`/admin/users/${p.id}/reset-name`).then((r) => { name = r.data.data.username; }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`Name changed to ${name}.`); onDone(); } else fail(err, 'Could not reset the name.');
  }
  return (
    <Modal title="Reset name" description={`“${p.username}” becomes “Player” + 6 numbers. The player can choose a new name in the game.`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={go}>Reset name</Button></>}>
      <p className="text-sm text-slate-600">Use this for offensive or impersonating names. It is written to the audit log.</p>
    </Modal>
  );
}

function BanDialog({ p, onClose, onDone }: DialogProps) {
  const [reason, setReason] = useState('');
  const m = useMutation();
  const banning = !p.isBanned;
  async function go() {
    if (banning && !reason.trim()) return toast.error('Write a short reason (the team will see it).');
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/users/${p.id}/ban`, { isBanned: banning, reason: banning ? reason.trim() : undefined }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(banning ? `${p.username} is banned.` : `${p.username} can play again.`); onDone(); }
    else fail(err, banning ? 'Could not ban.' : 'Could not unban.');
  }
  return (
    <Modal title={banning ? `Ban ${p.username}` : `Unban ${p.username}`}
      description={banning ? 'They are logged out of the game at once and cannot log in again until unbanned.' : `Banned${p.banReason ? `: ${p.banReason}` : ''}.`}
      onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant={banning ? 'danger' : 'success'} loading={m.loading} onClick={go}>{banning ? 'Ban' : 'Unban'}</Button></>}>
      {banning
        ? <Input label="Reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. cheating, abusive chat" />
        : <p className="text-sm text-slate-600">They can log in and play again.</p>}
    </Modal>
  );
}
