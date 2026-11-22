'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { RefreshCw, Trash2, UserX } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { errorText, RequireRole } from '@/lib/admin';
import { ago } from '@/components/players/bits';

interface Msg { id: string; senderId: string; username: string; kind: 'TEXT' | 'EMOJI'; text: string; sentAt: string }

export default function GlobalChatPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><GlobalChat /></RequireRole>;
}

function GlobalChat() {
  const { data, loading, refetch } = useFetch<Msg[]>('/admin/global-chat');
  const [confirm, setConfirm] = useState<{ kind: 'one'; msg: Msg } | { kind: 'player'; msg: Msg } | { kind: 'all' } | null>(null);
  const m = useMutation();
  const messages = [...(data ?? [])].reverse(); // newest first

  useEffect(() => {
    const t = setInterval(refetch, 15_000);
    return () => clearInterval(t);
  }, [refetch]);

  async function run() {
    if (!confirm) return;
    let err: unknown; let removed = 0;
    const call = confirm.kind === 'all'
      ? api.delete('/admin/global-chat')
      : api.post('/admin/global-chat/remove', confirm.kind === 'one' ? { messageId: confirm.msg.id } : { userId: confirm.msg.senderId });
    const ok = await m.run(() => call.then((r) => { removed = r.data.data.removed; }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`${removed} message${removed === 1 ? '' : 's'} removed.`); setConfirm(null); refetch(); }
    else toast.error(errorText(err, 'Could not remove.'));
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Global chat</h1>
          <p className="text-sm text-slate-500 mt-0.5">The public chat on the table list (last 50 messages). Remove anything offensive.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={refetch}>Refresh</Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={!messages.length} onClick={() => setConfirm({ kind: 'all' })}>Clear all</Button>
        </div>
      </div>

      <p className="text-xs text-slate-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
        Removed messages disappear for everyone who opens the chat. Players who have it open right now still see them until they reopen it.
      </p>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading && !data ? <p className="text-sm text-slate-400 text-center py-10">Loading…</p> : messages.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-12">Global chat is empty.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {messages.map((msg) => (
              <li key={msg.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-500">
                    <Link href={`/users/${msg.senderId}`} className="font-semibold text-slate-800 hover:text-blue-600">{msg.username}</Link> · {ago(msg.sentAt)}
                  </p>
                  <p className={`text-slate-800 break-words ${msg.kind === 'EMOJI' ? 'text-2xl' : 'text-sm'}`}>{msg.text}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button title="Remove this message" onClick={() => setConfirm({ kind: 'one', msg })}
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
                  <button title="Remove all messages from this player" onClick={() => setConfirm({ kind: 'player', msg })}
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"><UserX size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirm && (
        <Modal
          title={confirm.kind === 'all' ? 'Clear Global chat' : confirm.kind === 'one' ? 'Remove message' : `Remove all from ${confirm.msg.username}`}
          description={confirm.kind === 'all' ? 'Every message is removed for everyone.' : confirm.kind === 'one' ? `“${confirm.msg.text.slice(0, 80)}”` : 'Every message this player wrote in Global chat is removed.'}
          onClose={() => setConfirm(null)}
          footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={m.loading} onClick={run}>Remove</Button></>}>
          <p className="text-sm text-slate-600">This is written to the audit log.{confirm.kind !== 'all' && ' To stop them writing again, ban them from their profile.'}</p>
        </Modal>
      )}
    </div>
  );
}
