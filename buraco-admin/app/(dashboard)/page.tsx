'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  Users, UserX, Gamepad2, Zap, UserPlus, Activity, Wifi, Crown,
  ShoppingCart, CreditCard, Coins, Flag, ImageIcon, RefreshCw,
} from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import StatCard from '@/components/ui/StatCard';
import { StatSkeleton } from '@/components/ui/Skeleton';
import { useAdmin } from '@/lib/admin';

interface TopPlayer { id: string; username: string; avatarUrl: string | null; points: number; level: number; winPercentage: number }
interface Day { date: string; newPlayers: number; matches: number }
interface Dashboard {
  players: { total: number; onlineNow: number | null; activeToday: number; newToday: number; banned: number; subscribers: number };
  matches: { live: number; today: number; total: number };
  economy: { coinsSpentToday: number; purchasesToday: number; coinsBoughtToday: number };
  todo: { openReports: number; pendingCustomCards: number };
  last7Days: Day[];
  topPlayers: TopPlayer[];
}

const REFRESH_MS = 30_000;

export default function DashboardPage() {
  const { data, loading, error, refetch } = useFetch<Dashboard>('/admin/dashboard');
  const { can } = useAdmin();

  // Keep the numbers fresh while the page is open.
  useEffect(() => {
    const t = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(t);
  }, [refetch]);

  useEffect(() => {
    if (error) toast.error('Could not load the dashboard. Is the server running?');
  }, [error]);

  if (loading && !data) return <StatSkeleton />;
  if (!data) return <p className="text-sm text-slate-500">No data.</p>;
  const { players, matches, economy, todo } = data;
  const attention = todo.openReports + todo.pendingCustomCards;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">The game right now · &quot;today&quot; = last 24 hours</p>
        </div>
        <button onClick={refetch} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 rounded-lg px-2 py-1.5 hover:bg-white">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Needs attention */}
      <section>
        <SectionTitle>Needs attention</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <StatCard label="Open reports" value={todo.openReports} Icon={Flag}
            color={todo.openReports ? 'bg-red-500' : 'bg-slate-300'} hint="Players reported by others" />
          <StatCard label="Custom cards" value={todo.pendingCustomCards} Icon={ImageIcon}
            color={todo.pendingCustomCards ? 'bg-amber-500' : 'bg-slate-300'} hint="Waiting for approval" />
        </div>
        {attention === 0 && <p className="text-xs text-slate-400 mt-2">Nothing waiting. 👍</p>}
      </section>

      {/* Players */}
      <section>
        <SectionTitle>Players</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Online now" value={players.onlineNow} Icon={Wifi} color="bg-emerald-600" hint="In the game this minute" />
          <StatCard label="Active today" value={players.activeToday} Icon={Activity} color="bg-teal-600" />
          <StatCard label="New today" value={players.newToday} Icon={UserPlus} color="bg-cyan-600" />
          <StatCard label="All players" value={players.total} Icon={Users} color="bg-blue-600" href="/users" />
          <StatCard label="Subscribers" value={players.subscribers} Icon={Crown} color="bg-violet-600" hint="Basic or Premium" />
          <StatCard label="Banned" value={players.banned} Icon={UserX} color="bg-red-500" />
        </div>
      </section>

      {/* Matches */}
      <section>
        <SectionTitle>Matches</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Playing now" value={matches.live} Icon={Zap} color="bg-amber-500" href="/games" />
          <StatCard label="Today" value={matches.today} Icon={Gamepad2} color="bg-orange-500" />
          <StatCard label="All time" value={matches.total} Icon={Gamepad2} color="bg-slate-500" />
        </div>
      </section>

      {/* Economy: coins and store purchases are business numbers, for super admins */}
      {can(['SUPER_ADMIN']) && (
        <section>
          <SectionTitle>Shop and purchases · today</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard label="Coins spent" value={economy.coinsSpentToday} Icon={ShoppingCart} color="bg-indigo-600" hint="In the shop (lives, tables…)" />
            <StatCard label="Store purchases" value={economy.purchasesToday} Icon={CreditCard} color="bg-emerald-600" hint="Google Play / App Store" />
            <StatCard label="Coins bought" value={economy.coinsBoughtToday} Icon={Coins} color="bg-yellow-500" hint="With real money" />
          </div>
        </section>
      )}

      {/* Last 7 days + top players */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Last 7 days</h2>
            <div className="flex gap-3 text-[11px] text-slate-500">
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-blue-500" /> New players</span>
              <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-amber-400" /> Matches</span>
            </div>
          </div>
          <WeekChart days={data.last7Days} />
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Top players</h2>
            <Link href="/leaderboard" className="text-xs text-blue-600 hover:underline font-medium">View all →</Link>
          </div>
          {data.topPlayers.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No player data yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.topPlayers.map((p, i) => (
                <li key={p.id}>
                  <Link href={`/users/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0
                      ${i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-slate-100 text-slate-600' : i === 2 ? 'bg-orange-100 text-orange-600' : 'text-slate-400'}`}>
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-slate-800 truncate">{p.username}</span>
                      <span className="block text-[11px] text-slate-400">Level {p.level} · {p.winPercentage.toFixed(0)}% wins</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-800">{p.points.toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{children}</h2>;
}

/** Two bars per day (new players, matches), scaled to the busiest day. */
function WeekChart({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.flatMap((d) => [d.newPlayers, d.matches]));
  const label = (iso: string) =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return (
    <div className="flex items-end gap-2 sm:gap-3 h-40">
      {days.map((d) => (
        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full">
          <div className="flex-1 w-full flex items-end justify-center gap-0.5 sm:gap-1">
            <Bar value={d.newPlayers} max={max} color="bg-blue-500" />
            <Bar value={d.matches} max={max} color="bg-amber-400" />
          </div>
          <span className="text-[10px] sm:text-[11px] text-slate-400">{label(d.date)}</span>
        </div>
      ))}
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="w-1/2 max-w-4 flex flex-col items-center justify-end h-full" title={String(value)}>
      {value > 0 && <span className="text-[10px] text-slate-500 tabular-nums">{value}</span>}
      <div className={`w-full rounded-t ${color}`} style={{ height: `${(value / max) * 85}%`, minHeight: value > 0 ? 3 : 0 }} />
    </div>
  );
}
