'use client';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import { ALL_ROLES, AdminRole, errorCode, errorStatus, errorText, RequireRole, ROLE_LABEL, useAdmin } from '@/lib/admin';

interface Row {
  id: string; email: string; name: string; role: AdminRole;
  isActive: boolean; createdAt: string; lastLoginAt: string | null;
}

const MIN = 12;
const ROLE_HELP: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Everything, including coins, shop, settings and admins',
  MODERATOR: 'Players (ban), reports, clans, broadcasts, games',
  SUPPORT: 'Looks up players and adds notes; support tickets',
};
const SELECT = 'block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

function RoleSelect({ value, onChange, disabled }: { value: AdminRole; onChange(r: AdminRole): void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-600">Role</label>
      <select className={SELECT} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as AdminRole)}>
        {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      <p className="text-xs text-slate-400">{ROLE_HELP[value]}</p>
    </div>
  );
}

export default function AdminsPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Admins /></RequireRole>;
}

function Admins() {
  const { admin: me } = useAdmin();
  const { data, loading, refetch } = useFetch<Row[]>('/admin/admins');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Admins</h1>
          <p className="text-sm text-slate-500 mt-0.5">Who can log in to this panel, and what they may do</p>
        </div>
        <Button icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Add admin</Button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Email</th>
              <th className="text-left px-4 py-3">Role</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Last login</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>}
            {(data ?? []).map((a) => (
              <tr key={a.id} className={a.isActive ? '' : 'opacity-60'}>
                <td className="px-4 py-3 font-medium text-slate-900">{a.name}{a.id === me?.id && <span className="text-slate-400 font-normal"> (you)</span>}</td>
                <td className="px-4 py-3 text-slate-600">{a.email}</td>
                <td className="px-4 py-3"><Badge variant={a.role === 'SUPER_ADMIN' ? 'purple' : a.role === 'MODERATOR' ? 'blue' : 'gray'}>{ROLE_LABEL[a.role]}</Badge></td>
                <td className="px-4 py-3"><Badge variant={a.isActive ? 'green' : 'red'}>{a.isActive ? 'Active' : 'Switched off'}</Badge></td>
                <td className="px-4 py-3 text-slate-500">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setEditing(a)}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && <AddAdmin onClose={() => setAdding(false)} onDone={() => { setAdding(false); refetch(); }} />}
      {editing && <EditAdmin row={editing} self={editing.id === me?.id} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refetch(); }} />}
    </div>
  );
}

function AddAdmin({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'SUPPORT' as AdminRole, password: '' });
  const [error, setError] = useState('');
  const { run, loading } = useMutation();

  async function submit() {
    setError('');
    if (form.password.length < MIN) return setError(`The password needs at least ${MIN} characters.`);
    let failure: unknown;
    const ok = await run(() => api.post('/admin/admins', form).catch((e) => { failure = e; throw e; }));
    if (ok) { toast.success(`${form.email} can now log in.`); onDone(); }
    else setError(errorStatus(failure) === 409
      ? 'An admin with this email already exists.' : errorText(failure, 'Could not add the admin.'));
  }

  return (
    <Modal title="Add admin" description="Give them the email and password yourself (e.g. by phone)." onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={loading} onClick={submit}>Add</Button></>}>
      <div className="space-y-4">
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
        <Input label={`Password (${MIN}+ characters)`} type="password" autoComplete="new-password"
          value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

function EditAdmin({ row, self, onClose, onDone }: { row: Row; self: boolean; onClose(): void; onDone(): void }) {
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<AdminRole>(row.role);
  const [isActive, setIsActive] = useState(row.isActive);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { run, loading } = useMutation();

  const MESSAGES: Record<string, string> = {
    CANNOT_DISABLE_SELF: "You can't switch off your own account.",
    CANNOT_CHANGE_OWN_ROLE: "You can't change your own role.",
    LAST_SUPER_ADMIN: 'There must always be one active super admin.',
  };

  async function submit() {
    setError('');
    if (password && password.length < MIN) return setError(`The new password needs at least ${MIN} characters.`);
    const body: Record<string, unknown> = {};
    if (name !== row.name) body.name = name;
    if (role !== row.role) body.role = role;
    if (isActive !== row.isActive) body.isActive = isActive;
    if (password) body.password = password;
    if (Object.keys(body).length === 0) return onClose();
    let failure: unknown;
    const ok = await run(() => api.patch(`/admin/admins/${row.id}`, body).catch((e) => { failure = e; throw e; }));
    if (ok) { toast.success('Saved.'); onDone(); }
    else setError(MESSAGES[errorCode(failure)] || errorText(failure, 'Could not save.'));
  }

  return (
    <Modal title={`Edit ${row.name}`} description={row.email} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={loading} onClick={submit}>Save</Button></>}>
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <RoleSelect value={role} onChange={setRole} disabled={self} />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isActive} disabled={self} onChange={(e) => setIsActive(e.target.checked)} />
          Can log in (untick to switch the account off)
        </label>
        <Input label={`New password (leave empty to keep; ${MIN}+ characters)`} type="password" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {self && <p className="text-xs text-slate-400">Your own role and access can only be changed by another super admin.</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
