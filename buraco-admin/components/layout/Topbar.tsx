'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, KeyRound, LogOut, Menu } from 'lucide-react';
import { clearToken } from '@/lib/auth';
import { ROLE_LABEL, useAdmin } from '@/lib/admin';
import { pageTitle } from './nav';

/** Top bar: menu button (phones), the page's name, and who is logged in with My password / Log out. */
export default function Topbar({ onMenu }: { onMenu(): void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { admin } = useAdmin();
  // The account menu stays open only on the page it was opened on, so changing page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof v === 'function' ? v(open) : v) ? pathname : null);
  const box = useRef<HTMLDivElement>(null);

  // Close the account menu on any click outside it.
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpenOn(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const initials = (admin?.name ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-20 h-14 bg-white/90 backdrop-blur border-b border-slate-200 flex items-center gap-3 px-4 lg:px-6">
      <button onClick={onMenu} className="lg:hidden -ml-1 rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label="Open menu">
        <Menu size={20} />
      </button>
      <p className="font-semibold text-slate-900 truncate">{pageTitle(pathname)}</p>

      <div className="ml-auto relative" ref={box}>
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100">
          <span className="w-8 h-8 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center">{initials}</span>
          <span className="hidden sm:block text-left leading-tight">
            <span className="block text-sm font-medium text-slate-900">{admin?.name ?? '…'}</span>
            <span className="block text-[11px] text-slate-500">{admin ? ROLE_LABEL[admin.role] : ''}</span>
          </span>
          <ChevronDown size={14} className="text-slate-400" />
        </button>
        {open && (
          <div className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 bg-white shadow-lg py-1">
            {admin && (
              <div className="px-4 py-2 border-b border-slate-100">
                <p className="text-sm font-medium text-slate-900 truncate">{admin.name}</p>
                <p className="text-xs text-slate-500 truncate">{admin.email}</p>
              </div>
            )}
            <Link href="/account" className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
              <KeyRound size={15} /> My password
            </Link>
            <button
              onClick={() => { clearToken(); router.push('/login'); }}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50"
            >
              <LogOut size={15} /> Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
