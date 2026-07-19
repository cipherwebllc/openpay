'use client';

// 店頭のお客様向け呼出モニター。受注閲覧トークンまたは受取ウォレットの SIWE で feed を読み、
// 未配膳注文の 6 桁受付番号だけを「準備中 / 呼出中」に表示する。品目・金額・メモは描画しない。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import { useOrderFeed } from '@/hooks/useOrderFeed';
import { useSiweSession } from '@/hooks/useSiweSession';
import {
  clearStoredOrderToken,
  getStoredOrderToken,
  setStoredOrderToken,
} from '@/lib/orderTokenClient';
import type { StoredOrder } from '@/lib/orderRelay';

const orderReceivedAt = (order: StoredOrder): number =>
  order.ts > 0 ? order.ts : Number.MAX_SAFE_INTEGER;
const orderReadyAt = (order: StoredOrder): number =>
  order.readyAt && order.readyAt > 0 ? order.readyAt : Number.MAX_SAFE_INTEGER;

export function OrderPickupMonitor({ initialToken }: { initialToken?: string }) {
  const t = useTranslations('OrderPickupMonitor');
  const tFulfillment = useTranslations('OrderFulfillment');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  const [token, setToken] = useState<string | null>(null);

  // kitchen / hall と同じ受注閲覧トークンを保持し、URL からは取り込み後に除去する。
  useEffect(() => {
    if (!env.enableOrderToken) return;
    if (initialToken) {
      setStoredOrderToken(initialToken);
      setToken(initialToken);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('t')) {
          url.searchParams.delete('t');
          window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
      } catch {
        /* history/URL API 障害をモニター表示へ波及させない。token は state/localStorage で保持済み。 */
      }
    } else {
      setToken(getStoredOrderToken());
    }
  }, [initialToken]);

  // サインイン済みのオーナーは保存済み token より SIWE を優先し、店舗の取り違えを防ぐ。
  const tokenMode = env.enableOrderToken && Boolean(token) && !isSignedIn;
  const { feed } = useOrderFeed(
    sessionAddress,
    isSignedIn,
    8_000,
    tokenMode ? token : null,
  );

  // rotate/revoke 済み token は保存から破棄してサインイン要求へ戻す。KV 障害では破棄しない。
  useEffect(() => {
    if (
      tokenMode &&
      feed.isError &&
      feed.error instanceof Error &&
      feed.error.message === 'invalid_token'
    ) {
      clearStoredOrderToken();
      setToken(null);
    }
  }, [tokenMode, feed.isError, feed.error]);

  if (!tokenMode && !isSignedIn) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-base text-slate-600">{tFulfillment('signInPrompt')}</p>
        <button
          type="button"
          onClick={() => void signIn(tFulfillment('signInStatement')).catch(() => {})}
          disabled={isSigningIn}
          className="mt-4 rounded-xl bg-brand px-5 py-2.5 text-base font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {isSigningIn ? tFulfillment('signingIn') : tFulfillment('signIn')}
        </button>
        {signInError ? (
          <p className="mt-3 text-sm text-red-600">{tFulfillment('signInError')}</p>
        ) : null}
      </div>
    );
  }

  if (feed.isError) {
    return (
      <p className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-base text-amber-800">
        {tFulfillment('loadError')}
      </p>
    );
  }

  if (feed.isLoading) {
    return (
      <p className="py-16 text-center text-base text-slate-400">
        {tFulfillment('loading')}
      </p>
    );
  }

  const activeOrders = (feed.data ?? []).filter((order) => !order.fulfilled);
  const preparingOrders = activeOrders
    .filter((order) => order.ready !== true)
    .sort((a, b) => orderReceivedAt(a) - orderReceivedAt(b));
  const callingOrders = activeOrders
    .filter((order) => order.ready === true)
    .sort(
      (a, b) =>
        orderReadyAt(a) - orderReadyAt(b) || orderReceivedAt(a) - orderReceivedAt(b),
    );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="mt-2 text-sm text-slate-400">{tFulfillment('autoRefresh')}</p>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
        <section
          aria-labelledby="pickup-preparing-heading"
          className="rounded-3xl border border-slate-200 bg-slate-50 p-5 sm:p-7 md:col-span-1 md:min-h-[68vh]"
        >
          <h2
            id="pickup-preparing-heading"
            className="text-2xl font-bold text-slate-700 sm:text-3xl"
          >
            {t('preparing')}
          </h2>
          {preparingOrders.length === 0 ? (
            <p className="mt-10 text-center text-base text-slate-400">{t('preparingEmpty')}</p>
          ) : (
            <ul className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
              {preparingOrders.map((order) => (
                <li
                  key={order.txHash}
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-5 text-center font-mono text-3xl font-bold tracking-wider text-slate-600 shadow-sm"
                >
                  {order.orderId}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="pickup-calling-heading"
          className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 sm:p-7 md:col-span-2 md:min-h-[68vh]"
        >
          <h2
            id="pickup-calling-heading"
            className="text-3xl font-bold text-emerald-900 sm:text-4xl"
          >
            {t('calling')}
          </h2>
          {callingOrders.length === 0 ? (
            <p className="mt-12 text-center text-lg text-emerald-700/60">{t('callingEmpty')}</p>
          ) : (
            <ul className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
              {callingOrders.map((order) => (
                <li
                  key={order.txHash}
                  // 番号は 6 桁固定。vw 基準の clamp はタイル幅 (列数依存) と連動せず中間幅で
                  // はみ出す (実機報告)。列側を auto-fill minmax(14rem) で下限保証し、フォントは
                  // 14rem に必ず収まる固定サイズにする (幅が余れば列数が増える)。
                  className="flex min-h-32 items-center justify-center rounded-3xl bg-emerald-600 px-4 py-7 text-center font-mono text-5xl font-black tracking-wide text-white shadow-lg shadow-emerald-900/10 sm:min-h-40"
                >
                  {order.orderId}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
