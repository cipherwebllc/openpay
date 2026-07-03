'use client';

// 圏外 (navigator.onLine === false) のときだけ、/create 上部に「前回の受け取り QR」を出す。
// QR は QRCodeSVG で端末内生成 = 通信不要。金額 / トークン・チェーン / 保存時刻を併記して
// 古い QR の取り違えを防ぐ。オンライン時は一切描画しない (null)。
//
// SSR / hydration 安全: 初回 render は online 扱い (null) に倒し、mount 後の useEffect で
// navigator.onLine を読み、online/offline イベントに追随する (AlphaNotice / PwaInstallHint と同型)。

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useLocalStorageRecord } from '@/hooks/useLocalStorageRecord';
import { isLastQrRecord, LAST_QR_KEY, type LastQrRecord } from '@/lib/offlineQr';

export function OfflineLastQr() {
  const t = useTranslations('OfflineLastQr');
  const locale = useLocale();
  const { load } = useLocalStorageRecord(LAST_QR_KEY, isLastQrRecord);
  const [offline, setOffline] = useState(false);
  const [record, setRecord] = useState<LastQrRecord | null>(null);

  useEffect(() => {
    const sync = () => {
      const isOffline = navigator.onLine === false;
      setOffline(isOffline);
      // 圏外に入った時点で最新の保存 QR を読み直す (mount 後に保存された場合も拾う)。
      if (isOffline) setRecord(load());
    };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, [load]);

  if (!offline || !record) return null;

  const savedAt = new Date(record.ts).toLocaleString(
    locale === 'en' ? 'en-US' : 'ja-JP',
  );

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <h2 className="text-sm font-bold text-slate-900">{t('title')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('description')}</p>
      <div className="mt-4 flex flex-col items-center gap-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <QRCodeSVG value={record.payUrl} size={200} />
        </div>
        {record.storeName ? (
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {record.storeName}
          </p>
        ) : null}
        <p className="text-sm text-slate-700">{record.amountLabel}</p>
        <p className="text-xs text-slate-500">{record.tokenChainLabel}</p>
        <p className="text-[11px] text-slate-400">
          {t('savedAt', { time: savedAt })}
        </p>
      </div>
      <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
        {t('paymentOfflineNote')}
      </p>
    </section>
  );
}
