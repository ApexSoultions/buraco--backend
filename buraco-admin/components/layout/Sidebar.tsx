'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { useAdmin } from '@/lib/admin';
import { NAV, isActive } from './nav';

/**
 * The dark side menu, grouped (Players, Community, Economy, …), showing only the pages the
 * logged-in admin's role may open. Always visible on wide screens; on phones it slides in
 * over the page from the top bar's menu button and closes when a page is picked.
 */
export default function Sidebar({ open, onClose }: { open: boolean; onClose(): void }) {
  const pathname = usePathname();
  const { can } = useAdmin();

  return (
    <>
      {/* Phone: dark layer behind the open menu; tap to close. */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-slate-950/50 lg:hidden transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-300 flex flex-col
          transition-transform duration-200 lg:static lg:translate-x-0 lg:shrink-0
          ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Brand */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <Link href="/" onClick={onClose} className="flex items-center gap-3">
            <Image src="/waraga-logo.png" alt="WARAGA" width={84} height={48} priority style={{ height: 48, width: "auto" }} />
            <div className="leading-tight">
              <p className="text-sm font-semibold text-white">WARAGA</p>
              <p className="text-[11px] text-slate-400">Admin panel</p>
            </div>
          </Link>
          <button onClick={onClose} className="lg:hidden rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        {/* Groups */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV.map((group) => {
            const items = group.items.filter((i) => can(i.roles));
            if (items.length === 0) return null;
            return (
              <div key={group.title} className="mt-4">
                <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.title}</p>
                {items.map(({ href, label, Icon }) => {
                  const active = isActive(pathname, href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onClose}
                      className={`flex items-center gap-3 px-3 py-2.5 lg:py-2 rounded-lg text-sm transition-colors
                        ${active ? 'bg-blue-600 text-white font-medium' : 'hover:bg-slate-800 hover:text-white'}`}
                    >
                      <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                      {label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <p className="px-6 py-3 text-[11px] text-slate-600 border-t border-slate-800">WARAGA · Barasilian Hand</p>
      </aside>
    </>
  );
}
