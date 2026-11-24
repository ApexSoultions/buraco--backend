'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, RotateCcw, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { errorText } from '@/lib/admin';
import { when } from '@/components/players/bits';

type Status = 'OPEN' | 'ANSWERED' | 'CLOSED';
interface Ticket {
  id: string; status: Status; name: string; email: string; social: string | null; message: string; createdAt: string;
  closedAt: string | null;
  user: { id: string; username: string; email: string; isBanned: boolean };
  replies: { id: string; adminName: string; message: string; createdAt: string }[];
}

const BADGE: Record<Status, { label: string; v: 'yellow' | 'blue' | 'gray' }> = {
  OPEN: { label: 'Waiting', v: 'yellow' }, ANSWERED: { label: 'Answered', v: 'blue' }, CLOSED: { label: 'Closed', v: 'gray' },
};
const MAX = 1500;

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { data: t, loading, error, refetch } = useFetch<Ticket>(`/admin/support/tickets/${id}`);
  const [reply, setReply] = useState('');
  const replyM = useMutation();
  const statusM = useMutation();

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error || !t) return (
    <div>
      <Link href="/support" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3"><ArrowLeft size={14} /> All messages</Link>
      <p className="text-sm text-slate-600">This message was not found.</p>
    </div>
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    let err: unknown;
    const ok = await replyM.run(() => api.post(`/admin/support/tickets/${id}/reply`, { message: reply.trim() }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success('Answer sent. The player gets it in the game and by email.'); setReply(''); refetch(); }
    else toast.error(errorText(err, 'Could not send the answer.'));
  }

  async function setStatus(status: 'OPEN' | 'CLOSED') {
    let err: unknown;
    const ok = await statusM.run(() => api.patch(`/admin/support/tickets/${id}/status`, { status }).catch((x) => { err = x; throw x; }));
    if (ok) { toast.success(status === 'CLOSED' ? 'Closed.' : 'Reopened.'); refetch(); }
    else toast.error(errorText(err, 'Could not change it.'));
  }

  return (
    <div className="max-w-3xl">
      <Link href="/support" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3"><ArrowLeft size={14} /> All messages</Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            {t.user.username} <Badge variant={BADGE[t.status].v}>{BADGE[t.status].label}</Badge>
            {t.user.isBanned && <Badge variant="red">Banned</Badge>}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Wrote as “{t.name}” · <a href={`mailto:${t.email}`} className="text-blue-600 hover:underline">{t.email}</a>
            {t.social ? <> · {t.social}</> : null} · {when(t.createdAt)}
          </p>
          <Link href={`/users/${t.user.id}`} className="text-xs text-blue-600 hover:underline">Open the player</Link>
        </div>
        {t.status === 'CLOSED'
          ? <Button variant="outline" size="sm" loading={statusM.loading} icon={<RotateCcw size={13} />} onClick={() => setStatus('OPEN')}>Reopen</Button>
          : <Button variant="outline" size="sm" loading={statusM.loading} icon={<CheckCircle2 size={13} />} onClick={() => setStatus('CLOSED')}>Close without answer</Button>}
      </div>

      <div className="space-y-3">
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">{t.name} wrote</p>
          <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">{t.message}</p>
        </div>
        {t.replies.map((r) => (
          <div key={r.id} className="bg-blue-50 rounded-xl border border-blue-100 px-4 py-3 ml-6">
            <p className="text-[11px] font-semibold text-blue-700 uppercase tracking-wide mb-1">{r.adminName} · {when(r.createdAt)}</p>
            <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">{r.message}</p>
          </div>
        ))}
      </div>

      <form onSubmit={send} className="mt-4 bg-white rounded-xl border border-slate-200 p-4">
        <label className="text-xs font-medium text-slate-600 block mb-1">Your answer</label>
        <textarea required rows={4} maxLength={MAX} value={reply} onChange={(e) => setReply(e.target.value)}
          placeholder="Write the answer the player will read in the game and in their email."
          className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white resize-none" />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px] text-slate-400">{reply.length} / {MAX}</span>
          <Button type="submit" loading={replyM.loading} disabled={reply.trim().length < 2} icon={<Send size={14} />}>Send answer</Button>
        </div>
      </form>
    </div>
  );
}
