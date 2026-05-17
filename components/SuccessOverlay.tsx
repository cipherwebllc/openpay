'use client';

// 対面決済 (即売会・コミケ・小規模店舗) で店主が顧客のスマホ画面を 1 秒で
// 視認できるよう、決済成功時に画面全体を緑色で塗りつぶす full-screen overlay。
// PayPay の「ペイペイ！」緑画面相当。

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CopyableField } from './CopyableField';
import { NonCustodialNotice } from './NonCustodialNotice';

function formatTimeHMS(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SuccessOverlay({
  amountDisplay,
  txHash,
  userOpHash,
  blockNumber,
  explorerBase,
  merchantAddress,
  onDismiss,
}: {
  amountDisplay: string;
  txHash: string;
  userOpHash?: string;
  blockNumber: bigint;
  explorerBase?: string;
  /**
   * 店舗ウォレットアドレス。指定時は Explorer の /address/ ページへの link を
   * 追加で描画し「他に何件着金しているか」を顧客 / 店主が即座に検証できるようにする。
   */
  merchantAddress?: string;
  onDismiss: () => void;
}) {
  const t = useTranslations('SuccessOverlay');
  const [now, setNow] = useState(() => new Date());
  const dialogRef = useRef<HTMLDivElement>(null);

  // 1 秒ごとに現在時刻を更新 (店主が「今支払った」と判断する時計)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ESC で dismiss + dialog に focus (a11y)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const explorerTxUrl =
    explorerBase && txHash ? `${explorerBase}/tx/${txHash}` : undefined;
  const explorerAddressUrl =
    explorerBase && merchantAddress
      ? `${explorerBase}/address/${merchantAddress}`
      : undefined;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-live="assertive"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-y-auto bg-emerald-500 px-4 py-8 text-white"
    >
      {/* 大きい ✓ + タイトル */}
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-3xl font-black text-emerald-600 sm:h-16 sm:w-16 sm:text-4xl"
        >
          ✓
        </span>
        <h2 className="text-3xl font-bold sm:text-4xl">{t('title')}</h2>
      </div>

      {/* 巨大金額 (店主が遠くから視認できるサイズ) */}
      <div className="text-center">
        <p className="text-xs uppercase tracking-wider opacity-80">
          {t('amountLabel')}
        </p>
        <p className="mt-1 break-all text-5xl font-black sm:text-6xl">
          {amountDisplay}
        </p>
      </div>

      {/* 完了時刻 (HH:MM:SS、毎秒更新) */}
      <div className="text-center">
        <p className="text-xs uppercase tracking-wider opacity-80">
          {t('timeLabel')}
        </p>
        <p className="mt-1 font-mono text-2xl tabular-nums sm:text-3xl">
          {formatTimeHMS(now)}
        </p>
      </div>

      {/* tx 詳細 (コピー可能) */}
      <dl className="w-full max-w-md space-y-1 rounded-lg bg-white/10 px-4 py-3 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="shrink-0 opacity-80">{t('txHashLabel')}</dt>
          <dd className="min-w-0 flex-1 text-right">
            <CopyableField
              value={txHash}
              label={t('txHashLabel')}
              displayValue={`${txHash.slice(0, 10)}…${txHash.slice(-6)}`}
              className="text-white"
            />
          </dd>
        </div>
        {userOpHash && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0 opacity-80">{t('userOpHashLabel')}</dt>
            <dd className="min-w-0 flex-1 text-right">
              <CopyableField
                value={userOpHash}
                label={t('userOpHashLabel')}
                displayValue={`${userOpHash.slice(0, 10)}…${userOpHash.slice(-6)}`}
                className="text-white"
              />
            </dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <dt className="shrink-0 opacity-80">{t('blockLabel')}</dt>
          <dd className="font-mono">{blockNumber.toString()}</dd>
        </div>
      </dl>

      <div className="flex flex-col items-center gap-1 text-sm">
        {explorerTxUrl && (
          <a
            href={explorerTxUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:opacity-80"
          >
            {t('explorerLink')}
          </a>
        )}
        {explorerAddressUrl && (
          <a
            href={explorerAddressUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:opacity-80"
          >
            {t('merchantAddressExplorerLink')}
          </a>
        )}
        <Link
          href="/history"
          prefetch={false}
          className="underline underline-offset-4 hover:opacity-80"
        >
          {t('viewLocalHistoryLink')}
        </Link>
      </div>

      {/* ノンカストディ宣言: 店主に「DB は持っていない、Explorer が source of truth」を毎回伝える */}
      <NonCustodialNotice
        variant="short"
        className="w-full max-w-md text-white"
      />

      {/* 明示的 dismiss (店主の視認後、客が押す) */}
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full bg-white px-8 py-3 text-base font-bold text-emerald-700 shadow-lg hover:bg-emerald-50"
        >
          {t('dismiss')}
        </button>
        <p className="text-[10px] opacity-70">{t('dismissHelp')}</p>
      </div>
    </div>
  );
}
