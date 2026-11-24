'use client';
import { useState } from 'react';
import { Send } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Empty from '@/components/ui/Empty';
import { errorCode, errorText, RequireRole } from '@/lib/admin';
import { ago } from '@/components/players/bits';

interface Sent { id: string; title: string; body: string; recipients: number; sentAt: string; sentBy: string }

const TITLE_MAX = 80;
const BODY_MAX = 300;

export default function BroadcastPage() {
  return <RequireRole roles={['SUPER_ADMIN', 'MODERATOR']}><Broadcast /></RequireRole>;
}

function Broadcast() {
  const [form, setForm] = useState({ title: '', body: '' });
  const [confirming, setConfirming] = useState(false);
  const audience = useFetch<{ count: number }>('/admin/broadcast/audience');
  const history = useFetch<Sent[]>('/admin/broadcast/history');
  const m = useMutation();
  const count = audience.data?.count;
  const ready = form.title.trim() !== '' && form.body.trim() !== '';

  async function send() {
    let err: unknown;
    const ok = await m.run(() => api.post('/admin/broadcast', { title: form.title.trim(), body: form.body.trim() }).catch((e) => { err = e; throw e; }));
    setConfirming(false);
    if (ok) { toast.success('Message sent.'); setForm({ title: '', body: '' }); history.refetch(); }
    else toast.error(errorCode(err) === 'ALREADY_SENT' ? 'This exact message was sent in the last 10 minutes.' : errorText(err, 'Could not send.'));
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Message to players</h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
          Sends one message to every active player. It appears in their game notifications, and straight away for players who are online. Banned players do not get it.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <form onSubmit={(e) => { e.preventDefault(); if (ready) setConfirming(true); }} className="space-y-4">
            <div>
              <Input label="Title" required maxLength={TITLE_MAX} value={form.title} placeholder="e.g. New season has started!"
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <p className="text-[11px] text-slate-400 mt-1 text-right">{form.title.length} / {TITLE_MAX}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">Message</label>
              <textarea required rows={4} maxLength={BODY_MAX} value={form.body} placeholder="What do you want to tell the players?"
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white resize-none" />
              <p className="text-[11px] text-slate-400 mt-1 text-right">{form.body.length} / {BODY_MAX}</p>
            </div>
            <Button type="submit" disabled={!ready} icon={<Send size={14} />} className="w-full justify-center">
              Review and send{count != null ? ` to ${count.toLocaleString()} players` : ''}
            </Button>
          </form>
        </div>

        <div className="bg-white rounded-xl border border-slate-200">
          <h2 className="px-4 py-3 text-sm font-semibold text-slate-900 border-b border-slate-100">Sent before</h2>
          {history.loading ? <p className="px-4 py-4 text-sm text-slate-400">Loading…</p>
            : (history.data ?? []).length === 0 ? <Empty message="No messages sent yet." />
            : (
              <ul className="divide-y divide-slate-50 max-h-[26rem] overflow-y-auto">
                {(history.data ?? []).map((h) => (
                  <li key={h.id} className="px-4 py-3">
                    <div className="flex justify-between gap-3">
                      <p className="text-sm font-medium text-slate-900">{h.title || 'Message'}</p>
                      <span className="text-xs text-slate-400 whitespace-nowrap">{ago(h.sentAt)}</span>
                    </div>
                    {h.body && <p className="text-xs text-slate-500 mt-0.5">{h.body}</p>}
                    <p className="text-[11px] text-slate-400 mt-1">{h.recipients.toLocaleString()} players{h.sentBy ? ` · ${h.sentBy}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>

      {confirming && (
        <Modal title={`Send to ${count != null ? count.toLocaleString() : 'all'} players?`} description="It can't be taken back once it is sent." onClose={() => setConfirming(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button><Button loading={m.loading} icon={<Send size={14} />} onClick={send}>Send now</Button></>}>
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">How players see it</p>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">{form.title.trim()}</p>
            <p className="text-sm text-slate-600 mt-0.5 whitespace-pre-wrap">{form.body.trim()}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
