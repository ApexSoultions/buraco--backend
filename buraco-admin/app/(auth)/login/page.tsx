'use client';
import { useState } from 'react';
import Image from 'next/image';
import toast from 'react-hot-toast';
import { Eye, EyeOff } from 'lucide-react';
import api from '@/lib/api';
import { setToken } from '@/lib/auth';
import Button from '@/components/ui/Button';

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [show,     setShow]     = useState(false);
  const [loading,  setLoading]  = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/admin/auth/login', { email, password });
      setToken(res.data.data.accessToken);
      // Hard navigation so the browser sends the new cookie with the next request.
      // router.replace() is a soft nav that can race with cookie propagation.
      window.location.href = '/';
    } catch {
      toast.error('Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-90">

        {/* Logo */}
        <div className="text-center mb-6">
          <Image src="/waraga-logo.png" alt="WARAGA" width={209} height={118} priority className="mx-auto mb-3" style={{ height: 112, width: "auto" }} />
          <h1 className="text-xl font-bold text-white">Admin panel</h1>
          <p className="text-sm text-slate-400 mt-1">Sign in to your admin account</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1.5">Email</label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm
                  placeholder:text-slate-400 outline-none transition
                  focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 pr-9 text-sm
                    outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <Button type="submit" loading={loading} className="w-full justify-center mt-1" size="lg">
              Sign in
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">WARAGA · Barasilian Hand — staff only</p>
      </div>
    </div>
  );
}
