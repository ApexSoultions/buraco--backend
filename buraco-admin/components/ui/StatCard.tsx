import Link from 'next/link';
import { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  value: number | string | null;
  Icon:  LucideIcon;
  color: string;
  /** Small grey line under the number, e.g. "last 24 h". */
  hint?: string;
  /** Makes the whole card a link. */
  href?: string;
}

export default function StatCard({ label, value, Icon, color, hint, href }: Props) {
  const body = (
    <div className={`h-full bg-white rounded-xl border border-slate-200 p-3.5 sm:p-5 flex items-center gap-3 sm:gap-4
      ${href ? 'hover:border-blue-300 hover:shadow-sm transition' : ''}`}>
      <div className={`${color} w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-white shrink-0`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] sm:text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug">{label}</p>
        <p className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight mt-0.5 tabular-nums">
          {value === null ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
        </p>
        {hint && <p className="text-[11px] text-slate-400 leading-snug">{hint}</p>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}
