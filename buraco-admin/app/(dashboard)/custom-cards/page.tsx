'use client';
import { useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Check, ImageOff, X } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { errorText, RequireRole } from '@/lib/admin';
import { ago, when } from '@/components/players/bits';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';
interface Card {
  id: string;
  status: Status;
  pricePaid: number;
  rejectReason: string | null;
  reviewedAt: string | null;
  reviewer: string | null;
  createdAt: string;
  imageUrl: string | null;
  user: { id: string; username: string };
}

const TABS: { status: Status; label: string }[] = [
  { status: 'PENDING', label: 'Waiting' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'REJECTED', label: 'Rejected' },
];

// Shown to the player in the "not approved" notification.
const REASONS = [
  'Offensive or adult picture',
  'Picture of another person without permission',
  'Copyrighted logo or brand',
  'Low quality or unreadable',
];

export default function CustomCardsPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><CustomCards /></RequireRole>;
}

function CustomCards() {
  const [status, setStatus] = useState<Status>('PENDING');
  const { data, loading, refetch } = useFetch<Card[]>('/admin/custom-cards', { status });
  const [rejecting, setRejecting] = useState<Card | null>(null);
  const [zoom, setZoom] = useState<Card | null>(null);
  const approveM = useMutation();
  const cards = data ?? [];

  async function approve(c: Card) {
    let err: unknown;
    const ok = await approveM.run(() => api.put(`/admin/custom-cards/${c.id}/approve`).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`Approved for ${c.user.username}. They were notified.`); refetch(); }
    else toast.error(errorText(err, 'Could not approve.'));
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Custom cards</h1>
        <p className="text-sm text-slate-500 mt-0.5">Pictures players uploaded as their own card back. Approve to let them use it; reject to refund their coins.</p>
      </div>

      <div className="flex gap-1 mb-4 bg-white border border-slate-200 rounded-xl p-1 w-full sm:w-auto sm:inline-flex">
        {TABS.map((t) => (
          <button key={t.status} onClick={() => setStatus(t.status)}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition
              ${status === t.status ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
            {t.label}{t.status === status && !loading ? ` (${cards.length})` : ''}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 animate-pulse">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="bg-white rounded-xl border border-slate-200 aspect-[180/314]" />)}
        </div>
      ) : cards.length === 0 ? (
        <p className="bg-white rounded-xl border border-slate-200 text-sm text-slate-400 text-center py-12">
          {status === 'PENDING' ? 'Nothing waiting for review. 👍' : 'Nothing here yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
          {cards.map((c) => (
            <div key={c.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col">
              <button onClick={() => setZoom(c)} className="block bg-slate-100" title="Bigger">
                <CardPicture url={c.imageUrl} />
              </button>
              <div className="p-3 flex-1 flex flex-col gap-2">
                <div className="min-w-0">
                  <Link href={`/users/${c.user.id}`} className="block font-medium text-slate-900 truncate hover:text-blue-600">{c.user.username}</Link>
                  <p className="text-xs text-slate-400">{ago(c.createdAt)} · paid {c.pricePaid.toLocaleString()} coins</p>
                </div>
                {c.status === 'PENDING' ? (
                  <div className="grid grid-cols-2 gap-2 mt-auto">
                    <Button size="sm" variant="success" icon={<Check size={14} />} loading={approveM.loading} onClick={() => approve(c)}>Approve</Button>
                    <Button size="sm" variant="danger" icon={<X size={14} />} onClick={() => setRejecting(c)}>Reject</Button>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 mt-auto">
                    {c.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {c.reviewer ?? 'Admin'} · {when(c.reviewedAt)}
                    {c.rejectReason && <><br /><span className="text-slate-700">“{c.rejectReason}”</span></>}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {zoom && (
        <Modal title={`${zoom.user.username}'s card`} description={`Uploaded ${when(zoom.createdAt)}`} onClose={() => setZoom(null)} size="sm">
          <div className="max-w-[260px] mx-auto rounded-lg overflow-hidden bg-slate-100"><CardPicture url={zoom.imageUrl} /></div>
        </Modal>
      )}
      {rejecting && <RejectDialog card={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); refetch(); }} />}
    </div>
  );
}

/** The picture in the game's card shape (180×314); a placeholder if the link fails. */
function CardPicture({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-[180/314] w-full flex items-center justify-center">
      {url && !failed
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="Custom card" className="w-full h-full object-cover" onError={() => setFailed(true)} />
        : <span className="flex flex-col items-center gap-1 text-xs text-slate-400"><ImageOff size={20} /> Picture not available</span>}
    </div>
  );
}

function RejectDialog({ card, onClose, onDone }: { card: Card; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState(REASONS[0]);
  const m = useMutation();
  async function go() {
    let err: unknown; let refunded = 0;
    const ok = await m.run(() => api.put(`/admin/custom-cards/${card.id}/reject`, { reason: reason.trim() || undefined })
      .then((r) => { refunded = r.data.data.refunded; }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`Rejected; ${refunded.toLocaleString()} coins refunded to ${card.user.username}.`); onDone(); }
    else toast.error(errorText(err, 'Could not reject.'));
  }
  return (
    <Modal title="Reject this card" description={`${card.user.username} gets their ${card.pricePaid.toLocaleString()} coins back and a notification with the reason.`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={go}>Reject and refund</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)}
              className={`text-xs rounded-full px-3 py-1.5 border ${reason === r ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              {r}
            </button>
          ))}
        </div>
        <Input label="Reason (the player sees it)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}
