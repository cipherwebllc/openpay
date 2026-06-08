'use client';

// 運営 (OpenPay 自社) 専用の収益ダッシュボード。SIWE サインイン → /api/admin/billing/revenue を読む。
// 認可は **API 側** (SIWE + ADMIN_WALLETS) が決定し、403 のときは「権限なし」を表示 (client は秘密を持たない)。
// 表示: 合計収益 / 対象期間別 / 支払い照合 (請求 vs 入金・未払い) / 入金一覧 + freee 用 CSV ダウンロード。
// 設計: docs/plans/admin-billing-revenue.md。

import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { useTranslations, useLocale } from 'next-intl';
import { useAccount } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';
import { txExplorerUrl, chainNameForId } from '@/lib/chains';
import { shortAddress } from '@/lib/format';

type Payment = { m: string; p: string; v: string; c: number; t: number; h: string };
type ReconRow = {
  merchant: string;
  billedFeeWei: string;
  paid: boolean;
  txHash: string | null;
  paidAtMs: number | null;
};
type RevenueResponse = {
  ok: true;
  totalWei: string;
  count: number;
  byBilledPeriod: { period: string; count: number; feeWei: string }[];
  reconciliation: { period: string; rows: ReconRow[] };
  payments: Payment[];
};

function jpyc(wei: string): string {
  const s = formatUnits(BigInt(wei), 18);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function AdminBillingView() {
  const t = useTranslations('AdminBilling');
  const locale = useLocale();
  const { isConnected } = useAccount();
  const { isSignedIn, isSigningIn, mismatch, signIn, signInError } =
    useSiweSession();

  const q = useQuery<RevenueResponse, Error>({
    queryKey: ['admin-billing-revenue'],
    enabled: isSignedIn,
    retry: false,
    queryFn: async () => {
      const res = await fetch('/api/admin/billing/revenue');
      if (res.status === 403) throw new Error('forbidden');
      const json = (await res.json().catch(() => ({}))) as
        | RevenueResponse
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : 'load_failed',
        );
      }
      return json;
    },
  });

  const heading = (
    <div className="mb-4">
      <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
      <p className="mt-1 text-sm text-slate-600">{t('intro')}</p>
    </div>
  );

  if (!isConnected) {
    return (
      <section>
        {heading}
        <p className="text-sm text-slate-500">{t('connectRequired')}</p>
      </section>
    );
  }

  if (!isSignedIn) {
    return (
      <section>
        {heading}
        {mismatch && (
          <p className="mb-2 text-xs text-red-600">{t('mismatch')}</p>
        )}
        <button
          type="button"
          onClick={() => void signIn(t('signInStatement')).catch(() => undefined)}
          disabled={isSigningIn}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {isSigningIn ? t('signingIn') : t('signIn')}
        </button>
        {signInError && (
          <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>
        )}
      </section>
    );
  }

  if (q.isLoading) {
    return (
      <section>
        {heading}
        <p className="text-sm text-slate-500">{t('loading')}</p>
      </section>
    );
  }

  if (q.isError) {
    const forbidden = q.error.message === 'forbidden';
    return (
      <section>
        {heading}
        <p className="text-sm text-red-600">
          {forbidden ? t('forbidden') : t('loadError')}
        </p>
      </section>
    );
  }

  const data = q.data;
  if (!data) return null;

  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

  return (
    <section>
      {heading}

      {/* 合計収益 + CSV */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500">{t('total')}</p>
        <p className="text-2xl font-bold text-slate-900">
          {jpyc(data.totalWei)} JPYC
          <span className="ml-2 text-sm font-normal text-slate-500">
            ({t('paymentsCount', { count: data.count })})
          </span>
        </p>
        {/* API ルートからの CSV ダウンロード (ページ遷移でない)。next/link は不適 (prefetch/client遷移して
            ダウンロードにならない) ため <a> が正しい。SIWE cookie は same-origin で自動送出される。 */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/admin/billing/revenue?format=freee"
          className="mt-3 inline-block rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          {t('downloadCsv')}
        </a>
      </div>

      {/* 支払い照合 (前月・請求 vs 入金) */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-slate-900">
          {t('reconcileTitle', { period: data.reconciliation.period })}
        </p>
        {data.reconciliation.rows.length === 0 ? (
          <p className="text-xs text-slate-500">{t('reconcileEmpty')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.reconciliation.rows.map((r) => (
              <li
                key={r.merchant}
                className="flex items-center justify-between gap-2 border-b border-slate-100 py-1"
              >
                <span className="font-mono text-slate-700">
                  {shortAddress(r.merchant)}
                </span>
                <span className="text-slate-600">{jpyc(r.billedFeeWei)} JPYC</span>
                <span
                  className={
                    r.paid
                      ? 'font-semibold text-emerald-700'
                      : 'font-semibold text-red-600'
                  }
                >
                  {r.paid ? t('paid') : t('unpaid')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 入金一覧 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-slate-900">
          {t('payments')}
        </p>
        {data.payments.length === 0 ? (
          <p className="text-xs text-slate-500">{t('noPayments')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.payments.map((p) => {
              const url = txExplorerUrl(p.c, p.h);
              return (
                <li
                  key={p.h}
                  className="flex items-center justify-between gap-2 border-b border-slate-100 py-1"
                >
                  <span className="text-slate-500">{fmtDate(p.t)}</span>
                  <span className="font-mono text-slate-700">
                    {shortAddress(p.m)}
                  </span>
                  <span className="text-slate-600">{jpyc(p.v)} JPYC</span>
                  <span className="text-slate-400">
                    {chainNameForId(p.c) ?? p.c}
                  </span>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-brand underline underline-offset-2"
                    >
                      tx
                    </a>
                  ) : (
                    <span className="font-mono text-slate-400">
                      {shortAddress(p.h)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
