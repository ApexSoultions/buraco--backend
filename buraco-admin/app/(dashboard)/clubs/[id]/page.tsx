'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Crown, ImageOff, PencilLine, Trash2, UserMinus } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ReasonModal from '@/components/clubs/ReasonModal';
import { errorCode, errorText, RequireRole } from '@/lib/admin';
import { ago, when } from '@/components/players/bits';

interface Member {
  userId: string; role: 'LEADER' | 'VICE_LEADER' | 'MEMBER'; status: 'ACTIVE' | 'PENDING'; points: number; joinedAt: string;
  user: { id: string; username: string; email: string; isBanned: boolean; lastSeenAt: string | null };
}
interface ClubDetail {
  id: string; name: string; iconUrl: string | null; welcomeMessage: string | null; mode: string; type: string;
  level: number; points: number; memberCount: number; maxMembers: number; minPoints: number; createdAt: string;
  members: Member[]; news: { id: string; type: string; text: string; createdAt: string }[];
}

type Action =
  | { kind: 'remove'; member: Member }
  | { kind: 'leader'; member: Member }
  | { kind: 'rename' }
  | { kind: 'icon' }
  | { kind: 'delete' };

const ROLE: Record<string, { label: string; v: 'blue' | 'yellow' | 'gray' }> = {
  LEADER: { label: 'Leader', v: 'blue' }, VICE_LEADER: { label: 'Vice leader', v: 'yellow' }, MEMBER: { label: 'Member', v: 'gray' },
};
const TH = 'text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap';

export default function ClubPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><Club /></RequireRole>;
}

function Club() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: club, loading, error, refetch } = useFetch<ClubDetail>(`/admin/clubs/${id}`);
  const [action, setAction] = useState<Action | null>(null);
  const m = useMutation();

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error || !club) return (
    <div>
      <Link href="/clubs" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3"><ArrowLeft size={14} /> All clans</Link>
      <p className="text-sm text-slate-600">This clan was not found. It may have been deleted.</p>
    </div>
  );

  const active = club.members.filter((x) => x.status === 'ACTIVE');
  const pending = club.members.filter((x) => x.status === 'PENDING');

  async function run(fn: () => Promise<unknown>, done: string, after?: () => void) {
    let err: unknown;
    const ok = await m.run(() => fn().catch((e) => { err = e; throw e; }));
    if (ok) {
      toast.success(done);
      setAction(null);
      if (after) after();
      else refetch();
    }
    else toast.error(errorCode(err) === 'IS_LEADER' ? "The leader can't be removed. Make someone else leader first, or delete the clan." : errorText(err, 'That did not work.'));
  }

  return (
    <div>
      <Link href="/clubs" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3"><ArrowLeft size={14} /> All clans</Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{club.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <Badge variant={club.mode === 'PROFESSIONAL' ? 'blue' : 'gray'}>{club.mode === 'PROFESSIONAL' ? 'Professional' : 'Classic'}</Badge>
            <Badge variant="gray">{club.type === 'OPEN' ? 'Open' : 'Request only'}</Badge>
            <span className="text-xs text-slate-400">Created {when(club.createdAt)}</span>
          </div>
          {club.welcomeMessage && <p className="text-sm text-slate-600 mt-2 max-w-xl">“{club.welcomeMessage}”</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" icon={<PencilLine size={13} />} onClick={() => setAction({ kind: 'rename' })}>Reset name</Button>
          {club.iconUrl && <Button variant="outline" size="sm" icon={<ImageOff size={13} />} onClick={() => setAction({ kind: 'icon' })}>Remove icon</Button>}
          <Button variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={() => setAction({ kind: 'delete' })}>Delete clan</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[['Level', club.level], ['Points', club.points.toLocaleString()], ['Members', `${club.memberCount} / ${club.maxMembers}`], ['Min. points to join', club.minPoints.toLocaleString()]].map(([l, v]) => (
          <div key={l} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{l}</p>
            <p className="text-xl font-semibold text-slate-900 tabular-nums mt-1">{v}</p>
          </div>
        ))}
      </div>

      <MemberTable title={`Members (${active.length})`} members={active} onRemove={(x) => setAction({ kind: 'remove', member: x })} onLeader={(x) => setAction({ kind: 'leader', member: x })} />
      {pending.length > 0 && (
        <div className="mt-5">
          <MemberTable title={`Waiting to join (${pending.length})`} members={pending} onRemove={(x) => setAction({ kind: 'remove', member: x })} />
        </div>
      )}

      <div className="mt-5 bg-white rounded-xl border border-slate-200">
        <h2 className="px-4 py-3 text-sm font-semibold text-slate-900 border-b border-slate-100">Recent news</h2>
        {club.news.length === 0 ? <p className="px-4 py-4 text-sm text-slate-500">Nothing yet.</p> : (
          <ul className="divide-y divide-slate-50">
            {club.news.map((n) => (
              <li key={n.id} className="px-4 py-2.5 flex justify-between gap-3 text-sm">
                <span className="text-slate-700">{n.text}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap">{ago(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {action?.kind === 'remove' && (
        <ReasonModal danger busy={m.loading}
          title={action.member.status === 'PENDING' ? `Decline ${action.member.user.username}?` : `Remove ${action.member.user.username}?`}
          description={action.member.status === 'PENDING' ? 'Their request is declined and they are told.' : 'They leave the clan and its chat, and are told.'}
          confirmLabel={action.member.status === 'PENDING' ? 'Decline' : 'Remove'}
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(() => api.delete(`/admin/clubs/${club.id}/members/${action.member.userId}`, { data: { reason } }), `${action.member.user.username} removed.`)} />
      )}
      {action?.kind === 'leader' && (
        <Modal title={`Make ${action.member.user.username} the leader?`} description="The current leader becomes vice leader." onClose={() => setAction(null)} size="sm"
          footer={<><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
            <Button loading={m.loading} onClick={() => run(() => api.post(`/admin/clubs/${club.id}/leader`, { userId: action.member.userId }), `${action.member.user.username} is the leader now.`)}>Make leader</Button></>}>
          <p className="text-sm text-slate-600">They are told about it in the game.</p>
        </Modal>
      )}
      {action?.kind === 'rename' && (
        <ReasonModal busy={m.loading} title="Reset the clan name?" description={`"${club.name}" becomes "Clan" and 6 digits. Members are told.`} confirmLabel="Reset name"
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(() => api.post(`/admin/clubs/${club.id}/reset-name`, { reason }), 'Name reset.')} />
      )}
      {action?.kind === 'icon' && (
        <Modal title="Remove the clan icon?" onClose={() => setAction(null)} size="sm"
          footer={<><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
            <Button variant="danger" loading={m.loading} onClick={() => run(() => api.delete(`/admin/clubs/${club.id}/icon`), 'Icon removed.')}>Remove icon</Button></>}>
          <p className="text-sm text-slate-600">The clan goes back to the default icon. The leader can set a new one.</p>
        </Modal>
      )}
      {action?.kind === 'delete' && (
        <ReasonModal danger busy={m.loading} title={`Delete "${club.name}"?`}
          description="The clan and its chat are deleted for everyone. This can't be undone. Members are told."
          confirmLabel="Delete clan" onClose={() => setAction(null)}
          onConfirm={(reason) => run(() => api.delete(`/admin/clubs/${club.id}`, { data: { reason } }), 'Clan deleted.', () => router.push('/clubs'))} />
      )}
    </div>
  );
}

function MemberTable({ title, members, onRemove, onLeader }: {
  title: string; members: Member[]; onRemove(m: Member): void; onLeader?(m: Member): void;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
      <h2 className="px-4 py-3 text-sm font-semibold text-slate-900 border-b border-slate-100">{title}</h2>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-100">
          <tr>{['Player', 'Role', 'Points', 'Joined', 'Last seen', ''].map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {members.map((x) => (
            <tr key={x.userId} className="hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <Link href={`/users/${x.user.id}`} className="font-medium text-blue-600 hover:underline">{x.user.username}</Link>
                {x.user.isBanned && <span className="ml-2"><Badge variant="red">Banned</Badge></span>}
              </td>
              <td className="px-4 py-3"><Badge variant={ROLE[x.role].v}>{ROLE[x.role].label}</Badge></td>
              <td className="px-4 py-3 tabular-nums text-slate-700">{x.points.toLocaleString()}</td>
              <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{when(x.joinedAt)}</td>
              <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{ago(x.user.lastSeenAt)}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-3 text-xs font-medium">
                  {onLeader && x.role !== 'LEADER' && x.status === 'ACTIVE' && (
                    <button onClick={() => onLeader(x)} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Crown size={12} /> Make leader</button>
                  )}
                  {x.role !== 'LEADER' && (
                    <button onClick={() => onRemove(x)} className="inline-flex items-center gap-1 text-red-500 hover:underline"><UserMinus size={12} /> {x.status === 'PENDING' ? 'Decline' : 'Remove'}</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
