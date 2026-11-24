'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import Badge, { BadgeVariant } from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';
import { RequireRole, ROLE_LABEL, AdminRole } from '@/lib/admin';
import { when } from '@/components/players/bits';

interface Entry {
  id: string; action: string; targetType: string; targetId: string; createdAt: string;
  details: Record<string, unknown> | null;
  admin: { id: string; name: string; email: string; role: AdminRole } | null;
}
interface Page { data: Entry[]; total: number; totalPages: number; groups: string[]; admins: { id: string; name: string }[] }

// What each action means, in plain words.
const LABEL: Record<string, string> = {
  BAN_USER: 'Banned a player', UNBAN_USER: 'Unbanned a player', EDIT_USER: 'Edited a player', RESET_NAME: 'Reset a player name',
  CREDIT_USER: 'Gave coins or diamonds', DEDUCT_USER: 'Took coins or diamonds', GIVE_LIVES: 'Gave lives', TAKE_LIVES: 'Took lives',
  SEND_ITEM: 'Sent an item to a player', RESET_PLAYER_STATS: 'Reset player stats', SET_PLAYER_SCORE: 'Set player points or level',
  VOID_GAME: 'Voided a match', REPORT_REVIEWED: 'Handled a report', REPORT_DISMISSED: 'Dismissed a report', REPORT_OPEN: 'Reopened a report',
  GLOBAL_CHAT_REMOVE: 'Removed Global chat messages', GLOBAL_CHAT_CLEAR: 'Cleared Global chat',
  APPROVE_CUSTOM_CARD: 'Approved a custom card', REJECT_CUSTOM_CARD: 'Rejected a custom card',
  CLUB_REMOVE_MEMBER: 'Removed a clan member', CLUB_MAKE_LEADER: 'Changed a clan leader', CLUB_RESET_NAME: 'Reset a clan name',
  CLUB_REMOVE_ICON: 'Removed a clan icon', DELETE_CLUB: 'Deleted a clan',
  CREATE_SHOP_ITEM: 'Created a shop item', UPDATE_SHOP_ITEM: 'Changed a shop item', ACTIVATE_SHOP_ITEM: 'Put a shop item on sale', DEACTIVATE_SHOP_ITEM: 'Hid a shop item',
  RESTORE_SHOP_PRICES: 'Restored the real shop prices', CREATE_PROMO: 'Created a promo code', UPDATE_PROMO: 'Changed a promo code',
  ACTIVATE_PROMO: 'Switched a promo code on', DEACTIVATE_PROMO: 'Switched a promo code off', DELETE_PROMO: 'Deleted a promo code',
  CREATE_MISSION: 'Created a mission', UPDATE_MISSION: 'Changed a mission', ACTIVATE_MISSION: 'Switched a mission on', DEACTIVATE_MISSION: 'Switched a mission off', DELETE_MISSION: 'Deleted a mission',
  CREATE_ACHIEVEMENT: 'Created an achievement', UPDATE_ACHIEVEMENT: 'Changed an achievement', DELETE_ACHIEVEMENT: 'Deleted an achievement',
  CREATE_CLUB_OBJECTIVE: 'Created a clan objective', UPDATE_CLUB_OBJECTIVE: 'Changed a clan objective', DELETE_CLUB_OBJECTIVE: 'Deleted a clan objective',
  SUPPORT_REPLY: 'Answered a support message', SUPPORT_CLOSE: 'Closed a support message', SUPPORT_REOPEN: 'Reopened a support message',
  UPDATE_SETTING: 'Changed a game setting', UPDATE_CONFIG: 'Changed a game setting (old)', BROADCAST: 'Sent a message to all players',
  CREATE_ADMIN: 'Created a staff account', UPDATE_ADMIN: 'Changed a staff account', CHANGE_OWN_PASSWORD: 'Changed own password',
  ADMIN_LOGIN: 'Logged in', ADMIN_LOGIN_FAILED: 'Wrong password for this account',
};

const TONE: [RegExp, BadgeVariant][] = [
  [/FAILED|BAN_USER$|^DELETE|DEDUCT|TAKE_|REJECT|CLEAR|REMOVE|VOID/, 'red'],
  [/^UNBAN/, 'green'],
  [/CREATE|CREDIT|GIVE|APPROVE|ACTIVATE_|LOGIN$/, 'green'],
  [/UPDATE|EDIT|RESET|SET_|SEND|RESTORE|MAKE_LEADER|CHANGE|REPLY|BROADCAST/, 'blue'],
];
const tone = (a: string): BadgeVariant => (a.startsWith('DEACTIVATE') ? 'gray' : TONE.find(([re]) => re.test(a))?.[1] ?? 'gray');

const humanize = (a: string) => a.charAt(0) + a.slice(1).toLowerCase().replace(/_/g, ' ');

// Where the target lives in the panel.
function targetLink(e: Entry): string | null {
  if (e.targetType === 'User') return `/users/${e.targetId}`;
  if (e.targetType === 'Club') return `/clubs/${e.targetId}`;
  if (e.targetType === 'SupportTicket') return `/support/${e.targetId}`;
  if (e.targetType === 'Report') return `/reports/${e.targetId}`;
  return null;
}

// A name for the target, if the entry saved one.
function targetName(e: Entry): string {
  const d = e.details ?? {};
  for (const k of ['username', 'name', 'title', 'club', 'code', 'label', 'newLeader', 'email']) if (typeof d[k] === 'string' && d[k]) return d[k] as string;
  return e.targetId.length > 12 ? `${e.targetId.slice(0, 8)}…` : e.targetId;
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Details as short lines: "price: 100 → 30,000" for changes, "reason: …" for the rest. */
function detailLines(d: Record<string, unknown> | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (['name', 'title', 'club', 'code', 'label', 'username', 'email'].includes(k) && typeof v === 'string') continue; // shown as the target
    if (k === 'changes' && v && typeof v === 'object') {
      for (const [f, pair] of Object.entries(v as Record<string, unknown>)) {
        out.push(Array.isArray(pair) ? `${f}: ${show(pair[0])} → ${show(pair[1])}` : `${f}: ${show(pair)}`);
      }
    } else if (k === 'from' || k === 'to') {
      if (k === 'from') out.push(`${show(d.from)} → ${show(d.to)}`);
    } else if (k === 'items' && Array.isArray(v)) {
      out.push(`${v.length} items`);
    } else out.push(`${k}: ${show(v)}`);
  }
  return out;
}

const SEL = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export default function AuditPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><Audit /></RequireRole>;
}

function Audit() {
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState('');
  const [adminId, setAdminId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const { data, loading } = useFetch<Page>('/admin/audit-logs', {
    page, limit: 50, ...(group ? { group } : {}), ...(adminId ? { adminId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(q ? { q } : {}),
  });
  const rows = data?.data ?? [];
  const reset = () => setPage(1);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500 mt-0.5">Everything staff did in the panel: who, when, what and what it changed. Passwords and secrets are never shown.</p>
      </div>

      <div className="grid grid-cols-2 lg:flex lg:flex-wrap gap-2 mb-4 items-center">
        <select value={group} onChange={(e) => { setGroup(e.target.value); reset(); }} className={SEL}>
          <option value="">All areas</option>
          {(data?.groups ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={adminId} onChange={(e) => { setAdminId(e.target.value); reset(); }} className={SEL}>
          <option value="">Everyone</option>
          {(data?.admins ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">From
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} className={`${SEL} w-full`} /></label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">To
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} className={`${SEL} w-full`} /></label>
        <form className="relative col-span-2 lg:ml-auto lg:w-64" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); reset(); }}>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Action or ID"
            className="block w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
        </form>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={10} cols={4} /> : rows.length === 0 ? <Empty message="Nothing matches." /> : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>{['When', 'Who', 'What', 'On', 'Details'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((e) => {
                  const link = targetLink(e);
                  const lines = detailLines(e.details);
                  return (
                    <tr key={e.id} className="hover:bg-slate-50/60 align-top">
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{when(e.createdAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-xs font-medium text-slate-800">{e.admin?.name ?? 'Unknown'}</p>
                        {e.admin && <p className="text-[11px] text-slate-400">{ROLE_LABEL[e.admin.role]}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={tone(e.action)}>{LABEL[e.action] ?? humanize(e.action)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {link ? <Link href={link} className="text-blue-600 hover:underline">{targetName(e)}</Link> : <span className="text-slate-700">{targetName(e)}</span>}
                        <p className="text-[11px] text-slate-400">{e.targetType}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 min-w-[14rem]">
                        {lines.length === 0 ? '—' : lines.map((l, i) => <p key={i} className="break-words">{l}</p>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-4 pb-3 flex items-center justify-between">
              <p className="text-xs text-slate-400 pt-3">{data?.total.toLocaleString()} entries</p>
              <Pagination page={page} totalPages={data?.totalPages ?? 1} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
