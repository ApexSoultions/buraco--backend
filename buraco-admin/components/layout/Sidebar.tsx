'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, Users, Gamepad2, ShoppingBag,
  Tag, Megaphone, Settings2, ScrollText, LogOut,
  Trophy, Shield, BarChart2, UserCog, KeyRound,
} from 'lucide-react';
import { clearToken } from '@/lib/auth';
import { AdminRole, ROLE_LABEL, useAdmin } from '@/lib/admin';

const ALL: AdminRole[] = ['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'];
const STAFF: AdminRole[] = ['SUPER_ADMIN', 'MODERATOR'];
const SUPER: AdminRole[] = ['SUPER_ADMIN'];

// Who sees each page (the server checks every action again).
const NAV = [
  { href: '/',             label: 'Dashboard',   Icon: LayoutDashboard, roles: ALL },
  { href: '/users',        label: 'Users',       Icon: Users,           roles: ALL },
  { href: '/games',        label: 'Games',       Icon: Gamepad2,        roles: ALL },
  { href: '/leaderboard',  label: 'Leaderboard', Icon: BarChart2,       roles: ALL },
  { href: '/clubs',        label: 'Clubs',       Icon: Shield,          roles: STAFF },
  { href: '/broadcast',    label: 'Broadcast',   Icon: Megaphone,       roles: STAFF },
  { href: '/shop',         label: 'Shop',        Icon: ShoppingBag,     roles: SUPER },
  { href: '/promos',       label: 'Promos',      Icon: Tag,             roles: SUPER },
  { href: '/missions',     label: 'Missions',    Icon: Trophy,          roles: SUPER },
  { href: '/config',       label: 'Config',      Icon: Settings2,       roles: SUPER },
  { href: '/admins',       label: 'Admins',      Icon: UserCog,         roles: SUPER },
  { href: '/audit',        label: 'Audit Logs',  Icon: ScrollText,      roles: SUPER },
];

function active(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export default function Sidebar() {
  const pathname = usePathname();
  const router   = useRouter();
  const { admin, can } = useAdmin();

  return (
    <aside className="w-56 shrink-0 min-h-screen bg-white border-r border-slate-200 flex flex-col">
      {/* Brand */}
      <div className="px-4 py-5 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white text-base font-bold shrink-0">
            B
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-900">Barasilian Cards Game Admin</p>
            <p className="text-[11px] text-slate-400">Management Portal</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.filter((n) => can(n.roles)).map(({ href, label, Icon }) => {
          const isActive = active(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
                ${isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'}`}
            >
              <Icon size={15} strokeWidth={isActive ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Who is logged in, own password, log out */}
      <div className="px-2 pb-4 border-t border-slate-100 pt-2">
        {admin && (
          <div className="px-3 py-2">
            <p className="text-sm font-medium text-slate-900 truncate">{admin.name}</p>
            <p className="text-[11px] text-slate-400 truncate">{admin.email} · {ROLE_LABEL[admin.role]}</p>
          </div>
        )}
        <Link
          href="/account"
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
            ${active(pathname, '/account') ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-50'}`}
        >
          <KeyRound size={15} strokeWidth={1.8} />
          My password
        </Link>
        <button
          onClick={() => { clearToken(); router.push('/login'); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <LogOut size={15} strokeWidth={1.8} />
          Log out
        </button>
      </div>
    </aside>
  );
}
