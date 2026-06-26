'use client';

// 顧客向け「注文状況」ページの本体 (お渡し準備完了通知・flag NEXT_PUBLIC_ENABLE_ORDER_PICKUP)。
// useOrderStatus で 8s ポーリングし、受付済み / 準備中 / お渡し準備完了 / 受け渡し済 を出し分ける。
//  - 「お渡し準備完了」へ遷移した瞬間にチャイム + バイブで知らせる (フォアグラウンド・1 回のみ)。
//  - Web Push / Service Worker は使わない方針ゆえ「この画面を開いたままお待ちください」を明示し、
//    対応ブラウザでは Screen Wake Lock で画面スリープを抑止、フォアグラウンド復帰で即再取得する。

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Clock,
  CookingPot,
  PackageCheck,
  CheckCircle2,
  CircleAlert,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { useOrderStatus } from '@/hooks/useOrderStatus';
import { primeChimeAudio, playNewOrderChime } from '@/lib/successChime';
import { tokyoHHMM } from '@/lib/shopTime';
import type { OrderPickupState } from '@/lib/orderRelay';

type Tone = 'active' | 'ready' | 'done' | 'error' | 'muted';

const TONE: Record<Tone, { card: string; icon: string; title: string }> = {
  active: { card: 'border-slate-200 bg-white', icon: 'text-brand', title: 'text-slate-900' },
  ready: { card: 'border-emerald-300 bg-emerald-50', icon: 'text-emerald-600', title: 'text-emerald-900' },
  done: { card: 'border-slate-200 bg-white', icon: 'text-emerald-600', title: 'text-slate-800' },
  error: { card: 'border-amber-300 bg-amber-50', icon: 'text-amber-500', title: 'text-amber-900' },
  muted: { card: 'border-slate-200 bg-white', icon: 'text-slate-400', title: 'text-slate-500' },
};

function StatusCard({
  tone,
  Icon,
  spin,
  title,
  hint,
  orderNo,
  orderNoLabel,
  children,
}: {
  tone: Tone;
  Icon: LucideIcon;
  spin?: boolean;
  title: string;
  hint?: string;
  orderNo?: string;
  orderNoLabel?: string;
  children?: ReactNode;
}) {
  const c = TONE[tone];
  return (
    <div
      className={`flex flex-col items-center rounded-3xl border px-6 py-10 text-center shadow-card ${c.card}`}
    >
      <span
        className={`flex h-16 w-16 items-center justify-center rounded-2xl bg-black/[0.03] ${c.icon}`}
      >
        <Icon className={`h-8 w-8 ${spin ? 'animate-spin' : ''}`} aria-hidden />
      </span>
      <h2 className={`mt-4 text-xl font-bold ${c.title}`}>{title}</h2>
      {hint && <p className="mt-2 max-w-xs text-sm leading-relaxed text-slate-500">{hint}</p>}
      {orderNo && (
        <p className="mt-4 rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-500">
          {orderNoLabel}
          <span className="ml-1 text-lg font-bold text-slate-900">#{orderNo}</span>
        </p>
      )}
      {children}
    </div>
  );
}

export function OrderStatusView({ token }: { token: string | null }) {
  const t = useTranslations('OrderStatus');
  const { data, isError, error, refetch } = useOrderStatus(token);
  const state = data?.state;
  const errorCode = isError && error instanceof Error ? error.message : null;
  const notFound = errorCode === 'not_found' || errorCode === 'invalid_token';

  // 「お渡し準備完了」への遷移を 1 回だけチャイム + バイブ。初回ロードで既に ready の場合は
  // 顧客が画面を見ている前提なので鳴らさない (prev === undefined のとき抑止)。
  const prevState = useRef<OrderPickupState | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const prev = prevState.current;
    prevState.current = state;
    if (state === 'ready' && prev !== undefined && prev !== 'ready') {
      playNewOrderChime();
      // 一部ブラウザ (iOS Safari) は vibrate 非対応 → 実行時に存在確認 (型上は常在だが runtime は別)。
      if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200]);
    }
  }, [state]);

  // 自動再生ポリシー (iOS 等) 対策: ナビゲーション直後は gesture が無いため、ページ上での
  // 最初のタップで 1 度だけ AudioContext を解錠する。
  useEffect(() => {
    const prime = () => primeChimeAudio();
    window.addEventListener('pointerdown', prime, { once: true });
    return () => window.removeEventListener('pointerdown', prime);
  }, []);

  // 受取待ち (received / preparing) の間だけ画面スリープを抑止 (対応ブラウザのみ) + フォアグラウンド
  // 復帰で即再取得。ready 到達でチャイム済 = 通知目的を達したので解放 (done も解放・plan §6.7)。
  // Wake Lock 非対応/拒否は keep-open 文言で代替する (機能影響なし)。
  const isWaiting = state === 'received' || state === 'preparing';
  useEffect(() => {
    if (!isWaiting) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        sentinel = null; // 非対応 / 不可視 / 拒否 — keep-open 文言で代替
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      void refetch(); // バックグラウンド中に準備完了していても復帰で即検知
      if (!sentinel) void acquire();
    };
    if ('wakeLock' in navigator) void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [isWaiting, refetch]);

  if (!token) {
    return (
      <StatusCard tone="error" Icon={CircleAlert} title={t('invalidLink')} hint={t('invalidLinkHint')} />
    );
  }

  // データがあればそれを優先描画 (poll 失敗時も最後の状態を保持)。無くてエラーなら error 画面。
  if (!data) {
    if (notFound) {
      return <StatusCard tone="error" Icon={CircleAlert} title={t('notFound')} hint={t('notFoundHint')} />;
    }
    if (isError) {
      return (
        <StatusCard tone="error" Icon={CircleAlert} title={t('unavailable')} hint={t('unavailableHint')} />
      );
    }
    return <StatusCard tone="muted" Icon={Loader2} spin title={t('updating')} />;
  }

  const orderNo = data.orderId;
  const orderNoLabel = t('orderNo');
  const readyTime = data.readyAt ? tokyoHHMM(data.readyAt) : null;

  if (state === 'ready') {
    return (
      <StatusCard
        tone="ready"
        Icon={PackageCheck}
        title={t('ready')}
        hint={t('readyHint')}
        orderNo={orderNo}
        orderNoLabel={orderNoLabel}
      >
        {readyTime && (
          <p className="mt-2 text-sm font-medium text-emerald-700">{t('readyAt', { time: readyTime })}</p>
        )}
      </StatusCard>
    );
  }
  if (state === 'done') {
    return (
      <StatusCard
        tone="done"
        Icon={CheckCircle2}
        title={t('done')}
        hint={t('doneHint')}
        orderNo={orderNo}
        orderNoLabel={orderNoLabel}
      />
    );
  }
  // received / preparing (受取待ち) — keep-open を表示。
  const isPreparing = state === 'preparing';
  return (
    <StatusCard
      tone="active"
      Icon={isPreparing ? CookingPot : Clock}
      title={isPreparing ? t('preparing') : t('received')}
      hint={isPreparing ? t('preparingHint') : t('receivedHint')}
      orderNo={orderNo}
      orderNoLabel={orderNoLabel}
    >
      <p className="mt-4 max-w-xs rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
        {t('keepOpen')}
      </p>
      {isError && <p className="mt-2 text-xs text-slate-400">{t('retrying')}</p>}
    </StatusCard>
  );
}
