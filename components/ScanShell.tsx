'use client';

// /scan ページの client root component。
//
// 構成:
//   1. ConnectionStatus (上部) — wallet 未接続/接続済を視認させる
//   2. PwaInstallHint — standalone でなければ install 手順
//   3. QrScannerSurface — カメラ起動 + decode + URL 手入力 fallback
//   4. ScanResultBanner — 「外部 URL」「未知 QR」「EIP-681」branch の警告 UI
//
// decode 成功 (kind: pay/tip/checkout) は即 router.push、success 後の戻る動線は
// 通常 router.back に頼る (history 1 つ前が /scan)。

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { PwaInstallHint } from './PwaInstallHint';
import { QrScannerSurface } from './QrScannerSurface';
import { parseScannedUrl, type ScanAction } from '@/lib/scan/parseScannedUrl';
import { useOrigin } from '@/hooks/useOrigin';
import { shortAddress } from '@/lib/format';
import type { Locale } from '@/i18n';
import { logger } from '@/lib/logger';

export function ScanShell() {
  const t = useTranslations('Scan');
  const router = useRouter();
  const locale = useLocale() as Locale;
  const origin = useOrigin();
  const { address, isConnected, chain } = useAccount();
  const [lastResult, setLastResult] = useState<ScanAction | null>(null);

  const handleScanned = useCallback(
    (raw: string) => {
      // origin は useOrigin が useEffect で hydrate 後にセットする。実質ここに
      // 到達することは稀だが、起こったときに silent drop されると「ボタン押した
      // のに何も起きない」状態を作るので Sentry breadcrumb を残す。
      if (!origin) {
        logger.warn('scan.before_hydrate', { rawLength: raw.length });
        return;
      }
      const action = parseScannedUrl(raw, origin, locale);
      setLastResult(action);

      if (
        action.kind === 'pay' ||
        action.kind === 'tip' ||
        action.kind === 'checkout'
      ) {
        // 観測指標: scan 経由の決済流入を Vercel Analytics で見るための breadcrumb。
        // raw URL は送らず route 種別のみ (個人情報 / 受取アドレスは集約しない方針)。
        logger.info('scan.deeplink', { kind: action.kind });
        router.push(action.href);
        return;
      }
      if (action.kind === 'external') {
        logger.warn('scan.external_qr', { host: action.host });
        return;
      }
      if (action.kind === 'eip681') {
        logger.warn('scan.eip681_rejected');
        return;
      }
      // unknown
      logger.warn('scan.unrecognized_qr');
    },
    [origin, locale, router],
  );

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('connectionTitle')}
        </h2>
        {isConnected && address ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              {shortAddress(address)}
              {chain && (
                <span className="text-emerald-600/70">/ {chain.name}</span>
              )}
            </span>
            <span className="text-xs text-slate-500">
              {t('connectionReadyHint')}
            </span>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-slate-500">{t('connectionPreHint')}</p>
            <ConnectButton />
          </div>
        )}
      </section>

      <PwaInstallHint />

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('scannerTitle')}
        </h2>
        <p className="mt-1 text-xs text-slate-500">{t('scannerDescription')}</p>
        <div className="mt-3">
          <QrScannerSurface onScanned={handleScanned} />
        </div>
      </section>

      {lastResult && (
        <ScanResultBanner result={lastResult} onDismiss={() => setLastResult(null)} />
      )}
    </div>
  );
}

function ScanResultBanner({
  result,
  onDismiss,
}: {
  result: ScanAction;
  onDismiss: () => void;
}) {
  const t = useTranslations('Scan');

  // pay / tip / checkout は即 router.push されるため、本 banner は表示し続けない。
  // 観測中に visual flash する程度の transient 表示のため、UI として描画はしない。
  if (
    result.kind === 'pay' ||
    result.kind === 'tip' ||
    result.kind === 'checkout'
  ) {
    return null;
  }

  if (result.kind === 'external') {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
        <p className="text-sm font-semibold">{t('externalQrTitle')}</p>
        <p className="mt-1 break-all font-mono text-xs">{result.href}</p>
        <p className="mt-2 text-xs">{t('externalQrBody', { host: result.host })}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={result.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700"
          >
            {t('externalQrOpen')}
          </a>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            {t('dismissResult')}
          </button>
        </div>
      </div>
    );
  }

  if (result.kind === 'eip681') {
    return (
      <div className="rounded-2xl border border-slate-300 bg-slate-50 p-4 text-slate-700">
        <p className="text-sm font-semibold">{t('eip681Title')}</p>
        <p className="mt-1 text-xs">{t('eip681Body')}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
        >
          {t('dismissResult')}
        </button>
      </div>
    );
  }

  // unknown
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">
      <p className="text-sm font-semibold">{t('unknownQrTitle')}</p>
      <p className="mt-1 break-all font-mono text-xs">{result.raw}</p>
      <p className="mt-2 text-xs">{t('unknownQrBody')}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 rounded-lg border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
      >
        {t('dismissResult')}
      </button>
    </div>
  );
}
