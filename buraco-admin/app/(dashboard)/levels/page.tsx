'use client';
import { useState } from 'react';
import { useFetch } from '@/hooks/useFetch';
import { TableSkeleton } from '@/components/ui/Skeleton';
import { RequireRole } from '@/lib/admin';

interface Row { level: number; xpForLevel: number; xpToReach: number; players: number }
interface Levels { levels: Row[]; playersAbove: number; clubPointsPerLevel: number }

export default function LevelsPage() {
  return <RequireRole roles={['SUPER_ADMIN']}><LevelTable /></RequireRole>;
}

function LevelTable() {
  const [upTo, setUpTo] = useState(50);
  const { data, loading } = useFetch<Levels>('/admin/content/levels', { upTo });
  const rows = data?.levels ?? [];
  const max = Math.max(1, ...rows.map((r) => r.players));

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Level table</h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
          How much XP each player level needs, and how many players are at each level now. The levels follow a fixed rule in the game server, so this page only shows them.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Rule title="Levels 1–10" text="100 XP × the level" />
        <Rule title="Levels 11–30" text="200 XP × the level" />
        <Rule title="Level 31 and up" text="350 XP × the level" />
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Clans: every {(data?.clubPointsPerLevel ?? 1000).toLocaleString()} clan points is one clan level.
      </p>

      <div className="flex gap-1 mb-3 bg-white border border-slate-200 rounded-xl p-1 w-full sm:w-auto sm:inline-flex">
        {[30, 50, 100].map((n) => (
          <button key={n} onClick={() => setUpTo(n)}
            className={`flex-1 sm:flex-none px-4 py-1.5 rounded-lg text-sm font-medium ${upTo === n ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            Up to level {n}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        {loading ? <TableSkeleton rows={8} cols={4} /> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                {['Level', 'XP to finish this level', 'Total XP to reach it', 'Players now'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r) => (
                <tr key={r.level} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 font-medium text-slate-900">{r.level}</td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-700">{r.xpForLevel.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-700">{r.xpToReach.toLocaleString()}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-slate-700 w-10">{r.players.toLocaleString()}</span>
                      {r.players > 0 && <span className="h-1.5 rounded bg-blue-500/70" style={{ width: `${Math.max(4, (r.players / max) * 120)}px` }} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!!data?.playersAbove && <p className="text-xs text-slate-500 mt-2">{data.playersAbove.toLocaleString()} more player{data.playersAbove === 1 ? ' is' : 's are'} above level {upTo}.</p>}
    </div>
  );
}

function Rule({ title, text }: { title: string; text: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{title}</p>
      <p className="text-sm font-medium text-slate-900 mt-1">{text}</p>
    </div>
  );
}
