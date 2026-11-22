'use client';
import { useState } from 'react';
import { usePaginated } from '@/hooks/useFetch';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  admin: { name: string; email: string; role: string };
}

export default function AuditPage() {
  const [page, setPage] = useState(1);

  const { items: logs, totalPages, loading } = usePaginated<AuditLog>(
    '/admin/audit-logs', { page, limit: 50 },
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500 mt-0.5">Full history of admin actions</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <TableSkeleton rows={10} cols={5} />
        ) : logs.length === 0 ? (
          <Empty message="No audit logs yet." />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Time', 'Admin', 'Action', 'Target', 'Details'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800 text-xs">{log.admin.name}</p>
                      <Badge variant="gray">{log.admin.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-600 text-xs">{log.targetType}</p>
                      <p className="font-mono text-[11px] text-slate-400">{log.targetId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">
                      {log.details ? JSON.stringify(log.details) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-3">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
