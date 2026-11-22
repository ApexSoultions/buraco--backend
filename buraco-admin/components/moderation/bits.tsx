import Badge, { type BadgeVariant } from '@/components/ui/Badge';

export type ReportStatus = 'OPEN' | 'REVIEWED' | 'DISMISSED';
export type ReportSource = 'MESSAGES' | 'TABLE_CHAT' | 'GLOBAL_CHAT' | 'OTHER';

export const SOURCE_LABEL: Record<ReportSource, string> = {
  MESSAGES: 'Private messages',
  TABLE_CHAT: 'Table chat',
  GLOBAL_CHAT: 'Global chat',
  OTHER: 'Other',
};

export const REASON_LABEL: Record<string, string> = {
  SPAM: 'Spam',
  ABUSE: 'Abuse',
  INAPPROPRIATE: 'Inappropriate',
  CHEATING: 'Cheating',
  OTHER: 'Other',
};

const STATUS: Record<ReportStatus, { label: string; v: BadgeVariant }> = {
  OPEN: { label: 'Open', v: 'red' },
  REVIEWED: { label: 'Handled', v: 'green' },
  DISMISSED: { label: 'Dismissed', v: 'gray' },
};

export function StatusBadge({ status }: { status: ReportStatus }) {
  const s = STATUS[status] ?? STATUS.OPEN;
  return <Badge variant={s.v}>{s.label}</Badge>;
}

export function ReasonBadge({ reason }: { reason: string }) {
  return <Badge variant={reason === 'CHEATING' || reason === 'ABUSE' ? 'yellow' : 'blue'}>{REASON_LABEL[reason] ?? reason}</Badge>;
}
