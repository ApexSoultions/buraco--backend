'use client';
import { useState } from 'react';
import { CircleAlert, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { TableSkeleton } from '@/components/ui/Skeleton';
import { errorCode, errorText, RequireRole } from '@/lib/admin';
import { ago } from '@/components/players/bits';

interface Setting {
  key: string; label: string; description: string; group: string;
  type: 'number' | 'boolean' | 'text' | 'secret' | 'version';
  unit: string | null; connected: boolean; min: number | null; max: number | null; fallback: string | null;
  value: string | null; isSet: boolean; updatedAt: string | null;
}

const GROUPS = ['Players', 'Rewards', 'Email', 'Storage', 'Sign in', 'Not connected yet'];
const REASONS: Record<string, string> = {
  NOT_A_NUMBER: 'Use a whole number.',
  OUT_OF_RANGE: 'That number is outside the allowed range.',
  TOO_LONG: 'That is too long.',
  NOT_CONNECTED: 'The game does not use this setting yet.',
};

export default function ConfigPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Settings /></RequireRole>;
}

function Settings() {
  const { data, loading, refetch } = useFetch<Setting[]>('/admin/settings');
  const list = data ?? [];
  const groups = GROUPS.filter((g) => list.some((s) => s.group === g));

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Game settings</h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
          Changes reach the game within about a minute. Secret values are never shown again after you save them.
        </p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden"><TableSkeleton rows={8} cols={3} /></div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{g}</h2>
                {g === 'Not connected yet' && (
                  <p className="text-xs text-amber-700 mt-1 flex gap-1.5 items-start">
                    <CircleAlert size={13} className="mt-0.5 shrink-0" />
                    The game server does not read these yet, so changing them would do nothing. They are shown for reference only.
                  </p>
                )}
              </div>
              <ul className="divide-y divide-slate-50">
                {list.filter((s) => s.group === g).map((s) => <Row key={s.key} s={s} onSaved={refetch} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ s, onSaved }: { s: Setting; onSaved(): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const m = useMutation();
  const secret = s.type === 'secret';

  async function save(value: string) {
    let err: unknown;
    const ok = await m.run(() => api.put(`/admin/settings/${s.key}`, { value }).catch((e) => { err = e; throw e; }));
    if (ok) { toast.success(`${s.label} saved.`); setDraft(null); onSaved(); }
    else toast.error(REASONS[errorCode(err)] ?? errorText(err, `Could not save ${s.label}.`));
  }

  return (
    <li className={`px-4 py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-6 ${s.connected ? '' : 'opacity-60'}`}>
      <div className="md:w-80 shrink-0">
        <p className="text-sm font-medium text-slate-900 flex items-center gap-1.5">
          {s.label}
          {secret && <Lock size={11} className="text-slate-400" />}
        </p>
        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{s.description}</p>
      </div>

      <div className="flex-1 min-w-0">
        {draft !== null ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(draft); }}>
            <input autoFocus autoComplete="off" type={secret ? 'password' : 'text'} inputMode={s.type === 'number' ? 'numeric' : undefined}
              value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={secret ? 'New value' : s.fallback ?? 'Blank = server default'}
              className="rounded-lg border border-blue-300 ring-1 ring-blue-300 px-2.5 py-1.5 text-sm w-60 outline-none bg-white font-mono" />
            {s.unit && <span className="text-xs text-slate-400">{s.unit}</span>}
            <Button size="sm" type="submit" loading={m.loading}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {secret ? (
              <Badge variant={s.isSet ? 'green' : 'gray'}>{s.isSet ? 'Set' : 'Not set'}</Badge>
            ) : s.type === 'boolean' ? (
              <Badge variant={s.value === 'true' ? 'red' : 'green'}>{s.value === 'true' ? 'On' : 'Off'}</Badge>
            ) : s.value ? (
              <span className="text-sm font-semibold text-slate-900 font-mono break-all">{s.value}{s.unit ? <span className="ml-1 text-xs font-normal text-slate-400">{s.unit}</span> : null}</span>
            ) : (
              <span className="text-xs italic text-slate-400">{s.fallback ? `Using ${s.fallback}${s.unit ? ' ' + s.unit : ''} (default)` : 'Using the server’s own setting'}</span>
            )}
            {s.updatedAt && <span className="text-[11px] text-slate-300 hidden sm:inline">changed {ago(s.updatedAt)}</span>}
            {s.connected && (
              <span className="flex gap-3 text-xs font-medium">
                <button onClick={() => setDraft(secret ? '' : s.value ?? '')} className="text-blue-600 hover:underline">{secret ? (s.isSet ? 'Replace' : 'Set') : 'Edit'}</button>
                {secret && s.isSet && <button onClick={() => save('')} disabled={m.loading} className="text-red-500 hover:underline disabled:opacity-40">Clear</button>}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
