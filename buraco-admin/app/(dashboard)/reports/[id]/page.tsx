'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ArrowLeft, Ban, Check, RotateCcw, XCircle } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { errorText, RequireRole } from '@/lib/admin';
import { when } from '@/components/players/bits';
import { ReasonBadge, ReportSource, ReportStatus, SOURCE_LABEL, StatusBadge } from '@/components/moderation/bits';

interface Person { id: string; username: string; isBanned: boolean }
interface Report {
  id: string; status: ReportStatus; reason: string; source: ReportSource; details: string | null; createdAt: string;
  reporter: Person; reportedUser: Person;
  conversation: Array<{ id: string; senderId: string; username: string; text: string; createdAt: string; reported: boolean }>;
  review: { at: string; by: string; resolution: string | null } | null;
  otherReports: Array<{ id: string; reason: string; status: ReportStatus; createdAt: string; source: ReportSource }>;
}

export default function ReportPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><ReportView /></RequireRole>;
}

function ReportView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: r, loading, refetch } = useFetch<Report>(`/admin/reports/${id}`);
  const [dialog, setDialog] = useState<'handled' | 'dismiss' | 'ban' | null>(null);
  const m = useMutation();

  if (loading && !r) return <div className="h-64 bg-white rounded-xl animate-pulse" />;
  if (!r) return <p className="text-slate-500 text-center py-20">Report not found. <Link href="/reports" className="text-blue-600">Back</Link></p>;

  async function reopen() {
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/reports/${id}`, { status: 'OPEN' }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success('Report reopened.'); refetch(); } else toast.error(errorText(err, 'Could not reopen.'));
  }

  // Table / Global Chat reports carry the player's recent lines in the details.
  const lines = r.source === 'TABLE_CHAT' || r.source === 'GLOBAL_CHAT'
    ? (r.details ?? '').split('\n').slice(1).filter(Boolean)
    : [];
  const header = r.details?.split('\n')[0];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <button onClick={() => router.back()} className="p-1.5 -ml-1 rounded-lg hover:bg-white text-slate-500" aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg sm:text-xl font-semibold text-slate-900">Report against {r.reportedUser.username}</h1>
            <StatusBadge status={r.status} />
          </div>
          <p className="text-sm text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
            <ReasonBadge reason={r.reason} /> {SOURCE_LABEL[r.source]} · {when(r.createdAt)}
          </p>
        </div>
      </div>

      {/* Who */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PersonCard title="Reported player" p={r.reportedUser} />
        <PersonCard title="Reported by" p={r.reporter} />
      </div>

      {/* What was written */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">What was written</h2>
        {r.conversation.length > 0 ? (
          <ul className="space-y-2">
            {r.conversation.map((msg) => {
              const theirs = msg.senderId === r.reportedUser.id;
              return (
                <li key={msg.id} className={`rounded-lg px-3 py-2 text-sm ${msg.reported ? 'bg-red-50 border border-red-200' : theirs ? 'bg-amber-50' : 'bg-slate-50'}`}>
                  <p className="text-xs text-slate-500 mb-0.5">
                    <span className={theirs ? 'font-semibold text-slate-800' : ''}>{msg.username}</span> · {when(msg.createdAt)}
                    {msg.reported && <span className="ml-1.5 text-red-600 font-medium">← reported message</span>}
                  </p>
                  <p className="text-slate-800 whitespace-pre-wrap break-words">{msg.text || '—'}</p>
                </li>
              );
            })}
          </ul>
        ) : lines.length > 0 ? (
          <>
            <p className="text-xs text-slate-400 mb-2">{header} — the last messages from {r.reportedUser.username} when the report was sent:</p>
            <ul className="space-y-1.5">
              {lines.map((l, i) => <li key={i} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-slate-800 break-words">{l}</li>)}
            </ul>
          </>
        ) : (
          <p className="text-sm text-slate-500 whitespace-pre-wrap">{r.details || 'No messages were saved with this report.'}</p>
        )}
        {r.source === 'MESSAGES' && r.details && (
          <p className="text-sm text-slate-600 mt-3"><span className="text-slate-400">Reporter wrote:</span> {r.details}</p>
        )}
      </div>

      {/* Decision */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Decision</h2>
        {r.review && (
          <p className="text-sm text-slate-600 mb-3">
            {r.status === 'DISMISSED' ? 'Dismissed' : 'Handled'} by {r.review.by} · {when(r.review.at)}
            {r.review.resolution && <><br /><span className="text-slate-800">{r.review.resolution}</span></>}
          </p>
        )}
        {r.status === 'OPEN' ? (
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">
            <Button variant="danger" icon={<Ban size={15} />} onClick={() => setDialog('ban')} disabled={r.reportedUser.isBanned}>
              {r.reportedUser.isBanned ? 'Already banned' : `Ban ${r.reportedUser.username}`}
            </Button>
            <Button variant="success" icon={<Check size={15} />} onClick={() => setDialog('handled')}>Mark handled</Button>
            <Button variant="outline" icon={<XCircle size={15} />} onClick={() => setDialog('dismiss')}>Dismiss (nothing wrong)</Button>
          </div>
        ) : (
          <Button variant="outline" icon={<RotateCcw size={15} />} loading={m.loading} onClick={reopen}>Reopen</Button>
        )}
        <p className="text-xs text-slate-400 mt-3">
          A warning, a name reset or coins: open <Link href={`/users/${r.reportedUser.id}`} className="text-blue-600 hover:underline">{r.reportedUser.username}&apos;s profile</Link>, then mark this report handled.
        </p>
      </div>

      {/* Other reports against the same player */}
      {r.otherReports.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Other reports against {r.reportedUser.username}</h2>
          <ul className="divide-y divide-slate-100">
            {r.otherReports.map((o) => (
              <li key={o.id}>
                <Link href={`/reports/${o.id}`} className="flex items-center gap-2 py-2 text-sm hover:text-blue-600">
                  <ReasonBadge reason={o.reason} /> <span className="text-slate-600">{SOURCE_LABEL[o.source]}</span>
                  <span className="text-xs text-slate-400 ml-auto">{when(o.createdAt)}</span> <StatusBadge status={o.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog === 'ban' && <BanDialog r={r} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />}
      {(dialog === 'handled' || dialog === 'dismiss') && (
        <CloseDialog r={r} dismiss={dialog === 'dismiss'} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />
      )}
    </div>
  );
}

function PersonCard({ title, p }: { title: string; p: Person }) {
  return (
    <Link href={`/users/${p.id}`} className="bg-white rounded-xl border border-slate-200 p-3 hover:border-blue-300 block">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{title}</p>
      <p className="font-medium text-slate-900 flex items-center gap-2">{p.username} {p.isBanned && <Badge variant="red">Banned</Badge>}</p>
      <p className="text-xs text-blue-600">Open profile →</p>
    </Link>
  );
}

function CloseDialog({ r, dismiss, onClose, onDone }: { r: Report; dismiss: boolean; onClose(): void; onDone(): void }) {
  const [note, setNote] = useState('');
  const m = useMutation();
  async function go() {
    let err: unknown;
    const ok = await m.run(() => api.patch(`/admin/reports/${r.id}`, { status: dismiss ? 'DISMISSED' : 'REVIEWED', resolution: note || undefined }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(dismiss ? 'Report dismissed.' : 'Report marked handled.'); onDone(); } else toast.error(errorText(err, 'Could not save.'));
  }
  return (
    <Modal title={dismiss ? 'Dismiss report' : 'Mark handled'} description={dismiss ? 'Nothing wrong was done.' : 'You dealt with it (warning, name reset, …).'} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={m.loading} onClick={go}>{dismiss ? 'Dismiss' : 'Mark handled'}</Button></>}>
      <Input label="Note for the team (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={dismiss ? 'e.g. friendly banter' : 'e.g. warned by message, name reset'} />
    </Modal>
  );
}

function BanDialog({ r, onClose, onDone }: { r: Report; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState(r.reason === 'CHEATING' ? 'Cheating' : r.reason === 'SPAM' ? 'Spam in chat' : 'Abusive chat');
  const m = useMutation();
  async function go() {
    if (!reason.trim()) return toast.error('Write a reason.');
    let err: unknown; let closed = 0;
    const ok = await m.run(() => api.post(`/admin/reports/${r.id}/ban`, { reason }).then((res) => { closed = res.data.data.reportsClosed; }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`${r.reportedUser.username} is banned; ${closed} open report${closed === 1 ? '' : 's'} closed.`); onDone(); }
    else toast.error(errorText(err, 'Could not ban.'));
  }
  return (
    <Modal title={`Ban ${r.reportedUser.username}`} description="They are logged out at once and can't log in until unbanned. All open reports against them are closed." onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={go}>Ban</Button></>}>
      <Input label="Reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
