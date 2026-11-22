'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useMutation } from '@/hooks/useMutation';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { errorStatus, errorText, ROLE_LABEL, useAdmin } from '@/lib/admin';

const MIN = 12;

export default function AccountPage() {
  const { admin } = useAdmin();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', again: '' });
  const [error, setError] = useState('');
  const { run, loading } = useMutation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (form.newPassword.length < MIN) return setError(`The new password needs at least ${MIN} characters.`);
    if (form.newPassword !== form.again) return setError('The two new passwords are different.');
    let failure: unknown;
    const ok = await run(() => api.patch('/admin/auth/password', {
      currentPassword: form.currentPassword, newPassword: form.newPassword,
    }).catch((err) => { failure = err; throw err; }));
    if (ok) {
      toast.success('Password changed.');
      setForm({ currentPassword: '', newPassword: '', again: '' });
    } else {
      setError(errorStatus(failure) === 401 ? 'The current password is wrong.' : errorText(failure, 'Could not change the password.'));
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">My password</h1>
        {admin && <p className="text-sm text-slate-500 mt-0.5">{admin.email} · {ROLE_LABEL[admin.role]}</p>}
      </div>
      <div className="max-w-md bg-white rounded-xl border border-slate-200 p-5">
        <form onSubmit={submit} className="space-y-4">
          <Input label="Current password" type="password" autoComplete="current-password" required
            value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
          <Input label={`New password (${MIN}+ characters)`} type="password" autoComplete="new-password" required
            value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
          <Input label="New password again" type="password" autoComplete="new-password" required
            value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">Change password</Button>
        </form>
      </div>
    </div>
  );
}
