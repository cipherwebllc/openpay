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
  delinquent: boolean; // lookback 内に未払い請求あり+猶予超過 (履歴ぼかし+CSVロックの単一ソース)
  graceEndsAt: number; // 当月の遮断開始時刻 ms・UTC (予告バナーの「○○以降停止」用)
  due: BillingInvoiceLine; // 前月 (清算対象)
  current: BillingInvoiceLine; // 当月これまで (informational)
  owed: BillingInvoiceLine[]; // 未払いの請求期間一覧 (lookback 内・新しい順・期間別清算 UI 用)
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
