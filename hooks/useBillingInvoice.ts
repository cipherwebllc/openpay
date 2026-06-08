'use client';

// OpenPay 利用料 (a1) のインボイスを取得する hook (SIWE ログイン後に enabled)。
// /api/billing/invoice (S6) を react-query で読み、店主 UI (OpenPayFeePanel) が描画に使う。
// 支払い確定後に ['billing-invoice'] を invalidate して最新状態へ更新する。

import { useQuery } from '@tanstack/react-query';

export type BillingInvoiceLine = {
  period: string;
  count: number;
  volumeWei: string;
  rateBps: number;
  feeWei: string;
  free: boolean;
};

export type BillingInvoiceData = {
  feeCurrent: boolean;
  expiresAt: number | null;
  lastPaidPeriod: string | null;
  bypass: boolean;
  due: BillingInvoiceLine; // 前月 (清算対象)
  current: BillingInvoiceLine; // 当月これまで (informational)
};

export function useBillingInvoice(enabled: boolean) {
  return useQuery<BillingInvoiceData>({
    queryKey: ['billing-invoice'],
    enabled,
    queryFn: async () => {
      const res = await fetch('/api/billing/invoice');
      const json = (await res.json().catch(() => ({}))) as
        | (BillingInvoiceData & { ok: true })
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : 'invoice_failed',
        );
      }
      return json;
    },
  });
}
