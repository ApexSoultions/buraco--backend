import {
  LayoutDashboard, Users, Gamepad2, ShoppingBag, Tag, Megaphone, Settings2,
  ScrollText, Trophy, Shield, BarChart2, UserCog, Flag, MessagesSquare, type LucideIcon,
} from 'lucide-react';
import type { AdminRole } from '@/lib/admin';

const ALL: AdminRole[] = ['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'];
const STAFF: AdminRole[] = ['SUPER_ADMIN', 'MODERATOR'];
const SUPER: AdminRole[] = ['SUPER_ADMIN'];

export interface NavItem { href: string; label: string; Icon: LucideIcon; roles: AdminRole[] }
export interface NavGroup { title: string; items: NavItem[] }

/**
 * Every page of the panel, grouped as in the side menu, with the roles that may open it
 * (the server checks every action again). New pages are added here.
 */
export const NAV: NavGroup[] = [
  { title: 'Overview', items: [
    { href: '/', label: 'Dashboard', Icon: LayoutDashboard, roles: ALL },
  ] },
  { title: 'Players', items: [
    { href: '/users', label: 'Players', Icon: Users, roles: ALL },
    { href: '/games', label: 'Matches', Icon: Gamepad2, roles: ALL },
    { href: '/leaderboard', label: 'Leaderboard', Icon: BarChart2, roles: ALL },
  ] },
  { title: 'Moderation', items: [
    { href: '/reports', label: 'Reports', Icon: Flag, roles: STAFF },
    { href: '/global-chat', label: 'Global chat', Icon: MessagesSquare, roles: STAFF },
  ] },
  { title: 'Community', items: [
    { href: '/clubs', label: 'Clans', Icon: Shield, roles: STAFF },
    { href: '/broadcast', label: 'Broadcast', Icon: Megaphone, roles: STAFF },
  ] },
  { title: 'Economy', items: [
    { href: '/shop', label: 'Shop', Icon: ShoppingBag, roles: SUPER },
    { href: '/promos', label: 'Promo codes', Icon: Tag, roles: SUPER },
  ] },
  { title: 'Content', items: [
    { href: '/missions', label: 'Missions', Icon: Trophy, roles: SUPER },
  ] },
  { title: 'System', items: [
    { href: '/config', label: 'Game settings', Icon: Settings2, roles: SUPER },
    { href: '/admins', label: 'Admins', Icon: UserCog, roles: SUPER },
    { href: '/audit', label: 'Audit log', Icon: ScrollText, roles: SUPER },
  ] },
];

export function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
}

/** The page's label for the top bar ("My password" for /account). */
export function pageTitle(pathname: string): string {
  if (pathname.startsWith('/account')) return 'My password';
  for (const g of NAV) for (const i of g.items) if (isActive(pathname, i.href)) return i.label;
  return 'WARAGA Admin';
}
