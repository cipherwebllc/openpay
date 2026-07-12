'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';

const RECEIPT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function MobileOrderCallButton({
  handle,
  table,
  merchant,
}: {
  handle: string;
  table: string;
  merchant: string;
}) {
  const t = useTranslations('MobileOrder');
  const { receipts, hydrated } = usePayerReceipts();
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(
      () => setCooldown((seconds) => Math.max(0, seconds - 1)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const receipt = receipts.find((candidate) => {
    const paidAt = Date.parse(candidate.paidAt ?? candidate.createdAt);
    const age = Date.now() - paidAt;
    return (
      candidate.status === 'confirmed' &&
      typeof candidate.orderId === 'string' &&
      candidate.orderId.length > 0 &&
      typeof candidate.txHash === 'string' &&
      candidate.txHash.length > 0 &&
      candidate.merchantAddress.toLowerCase() === merchant.toLowerCase() &&
      Number.isFinite(paidAt) &&
      age >= 0 &&
      age <= RECEIPT_WINDOW_MS
    );
  });

  if (!hydrated || !receipt?.orderId || !receipt.txHash) return null;

  const callStaff = async () => {
    setSending(true);
    setError(false);
    try {
      const response = await fetch('/api/order/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          h: handle,
          table,
          orderId: receipt.orderId,
          txHash: receipt.txHash,
        }),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      setCooldown(30);
    } catch {
      // 呼び出し面の失敗を注文・決済 UI へ波及させず、この補助表示だけで知らせる。
      setError(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
      <button
        type="button"
        onClick={() => void callStaff()}
        disabled={sending || cooldown > 0}
        className="w-full rounded-xl border border-amber-400 bg-white px-4 py-2.5 text-sm font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
      >
        {cooldown > 0 ? t('callSent', { s: cooldown }) : t('callStaff')}
      </button>
      {error ? <p className="mt-2 text-xs text-slate-500">{t('callFailed')}</p> : null}
    </div>
  );
}
