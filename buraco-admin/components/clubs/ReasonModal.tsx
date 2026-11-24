'use client';
import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

/** Asks for an optional reason (sent to the player in the notification), then confirms. */
export default function ReasonModal({ title, description, confirmLabel, danger, busy, onConfirm, onClose }: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(reason: string): void;
  onClose(): void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} description={description} onClose={onClose} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
      </>}>
      <label className="text-xs font-medium text-slate-600 block mb-1">Reason (the player sees it; optional)</label>
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Offensive name"
        className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white" />
    </Modal>
  );
}
