'use client';

// /scan ページの client root component。
//
// 構成 (QR スキャナを最上部 = above the fold に保つため、ウォレットの状態はスキャナの
// 下に置く。接続済みなら保有残高が増えて縦に伸びても スキャナはスクロール不要):
//   1. PwaInstallHint — standalone でなければ install 手順 (条件付き)
//   2. QrScannerSurface — カメラ起動 + decode + URL 手入力 fallback
//   3. ConnectionStatus (+ WalletBalances) — wallet 未接続/接続済 + JPYC/USDC 保有残高
//   4. ScanResultBanner — 「外部 URL」「未知 QR」「EIP-681」branch の警告 UI
//
// decode 成功 (kind: pay/tip/checkout/handle/order) は即 router.push、success 後の戻る動線は
// 通常 router.back に頼る (history 1 つ前が /scan)。handle/order は自オリジンの既知 OpenPay
// ページ (固定店舗/プロフ・モバイル注文) で、flag は env から parseScannedUrl に渡して判定する。

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { CheckCircle2 } from 'lucide-react';
import { PwaInstallHint } from './PwaInstallHint';
import { QrScannerSurface } from './QrScannerSurface';
import { WalletBalances } from './WalletBalances';
import { PayerReceiptList } from './PayerReceiptList';
import { parseScannedUrl, type ScanAction } from '@/lib/scan/parseScannedUrl';
import { useOrigin } from '@/hooks/useOrigin';
import { shortAddress } from '@/lib/format';
import type { Locale } from '@/i18n';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export function ScanShell() {
  const t = useTranslations('Scan');
  const router = useRouter();
  const locale = useLocale() as Locale;
  const origin = useOrigin();
  const { address, isConnected, chain } = useAccount();
  const [lastResult, setLastResult] = useState<ScanAction | null>(null);

  // useQrScanner が onDecode を ref で持つため useCallback は不要 (毎 render で
  // 新規関数でも scanner は再生成されない)。
  function handleScanned(raw: string): void {
    if (!origin) {
      // hydrate race の silent drop を Sentry breadcrumb で観測可能にする。
      logger.warn('scan.before_hydrate', { rawLength: raw.length });
      return;
    }
    const action = parseScannedUrl(raw, origin, locale, {
      enableHandles: env.enableHandles,
      enableMobileOrder: env.enableMobileOrder,
    });
    setLastResult(action);

    switch (action.kind) {
      case 'pay':
      case 'tip':
      case 'checkout':
      case 'handle':
      case 'order':
        // raw URL は送らず route 種別のみ (受取アドレス / 金額は集約しない方針)。
        logger.info('scan.deeplink', { kind: action.kind });
        router.push(action.href);
        return;
      case 'external':
        logger.warn('scan.external_qr', { host: action.host });
        return;
      case 'eip681':
        logger.warn('scan.eip681_rejected');
        return;
      case 'unknown':
        logger.warn('scan.unrecognized_qr');
        return;
    }
  }

  return (
    <div className="space-y-5">
      <PwaInstallHint />

      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('scannerTitle')}
        </h2>
        <p className="mt-1 text-xs text-slate-500">{t('scannerDescription')}</p>
        <div className="mt-3">
          <QrScannerSurface onScanned={handleScanned} />
        </div>
      </section>

      {/* ウォレットの状態はスキャナの下に置く。接続済みなら保有残高 (JPYC/USDC を
          チェーン別に) も表示する — リストが伸びてもスキャナは上に固定されたまま。 */}
      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-slate-700">
          {t('connectionTitle')}
        </h2>
        {isConnected && address ? (
          // 接続/切断は AppHeader 右上の WalletBadge に集約。ここでは ready 状態の
          // 強調 (emerald badge) と保有残高だけを表示する。
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                {shortAddress(address)}
                {chain && (
                  <span className="text-emerald-600/70">/ {chain.name}</span>
                )}
              </span>
              <span className="text-xs text-slate-500">
                {t('connectionReadyHint')}
              </span>
            </div>
            <WalletBalances />
          </>
        ) : (
          <div className="mt-2">
            <p className="text-xs text-slate-500">{t('connectionPreHint')}</p>
          </div>
        )}
      </section>

      {/* 顧客向け電子レシート / 支払い控え (この端末のブラウザにのみ保存)。残高の下・
          QR 結果バナーの上に置き、過去の支払い控えを接続有無に関わらず確認できるようにする。 */}
      <PayerReceiptList />

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
    result.kind === 'checkout' ||
    result.kind === 'handle' ||
    result.kind === 'order'
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
