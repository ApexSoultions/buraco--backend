import Badge from '@/components/ui/Badge';

/** Subscription plan as a coloured badge. */
export function PlanBadge({ status }: { status: string }) {
  if (status === 'PREMIUM') return <Badge variant="yellow">Premium</Badge>;
  if (status === 'BASIC') return <Badge variant="blue">Basic</Badge>;
  return <Badge variant="gray">Free</Badge>;
}

/** "5 min ago", "3 h ago", "2 d ago", or the date; "never" when empty. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Date and time, short. */
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
