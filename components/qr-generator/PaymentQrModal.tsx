'use client';

// 全画面プレビュー (ポスター調 + 印刷/コピー/SVG/PNG + × 閉じる)。決済QR/レジ共通の QrPreviewModal に、決済QR タブの
// 値と言葉を渡す。状態は持たない — 出す QR (payUrl・お店負担の QR の写し)・開閉と閉じる処理・コピーの状態・保存の
// ref と名前・お店の端末の状態と操作・着金の見張りの結果は親の QrGenerator が持ち、ここは「お店負担の QR を出して
// いるか」(storeQr) で出し分けて中継するだけ。

import type { RefObject } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import type { Address, Chain } from 'viem';
import { QrPreviewModal } from '@/components/QrPreviewModal';
import { RecoverFeeNotice } from '@/components/RecoverFeeNotice';
import { downloadPng, downloadSvg } from '@/components/qr/qrDownload';
import type { StoreDeviceMode } from '@/components/StoreDeviceProvider';
import type { QrSettings } from '@/hooks/useQrSettings';
import type { IncomingPaymentStatus } from '@/hooks/useIncomingPaymentWatch';
import { env } from '@/lib/env';
import type { GasMode, PayMode } from '@/lib/fee';
import { formatTokenAmount, shortAddress } from '@/lib/format';
import { formatStoreDeviceAmount } from '@/lib/storeDevicePayment';
import type { TokenDeployment } from '@/lib/tokens';

// 「お店がガス代を肩代わりして送る」(flag 裏) の状態表示は選んだときだけ読み込む (使わない店の初回の読み込みに載せない)。
const StoreDeviceRegisterStatus = dynamic(
  () => import('@/components/StoreDeviceRegisterStatus').then((m) => m.StoreDeviceRegisterStatus),
  { ssr: false },
);

export function PaymentQrModal({
  open,
  dimmed,
  onClose,
  converted,
  storeQr,
  payUrl,
  amountLabelText,
  tokenChainLabelText,
  qrRef,
  qrFilename,
  copied,
  copy,
  eip681Uri,
  eip681Copied,
  eip681Copy,
  settings,
  payMode,
  chain,
  deployment,
  effectiveReceiver,
  device,
  onReissueStoreQr,
  onShowNormalQr,
  normalQrHasFee,
  normalQrFeeShown,
  recoverBillAmount,
  recoverGasMode,
  incomingStatus,
  receivedWei,
}: {
  open: boolean;
  /** QR を薄くする (為替換算の期限切れ・お店負担の QR が署名を待っていない)。 */
  dimmed: boolean;
  onClose: () => void;
  /** 為替換算を適用している (期限切れの通知の言葉を渡す)。 */
  converted: boolean;
  /** 出しているお店負担の QR (店員が通常の QR を選んだとき・出していないときは null)。 */
  storeQr: { url: string; amountText: string } | null;
  payUrl: string;
  amountLabelText: string;
  tokenChainLabelText: string;
  qrRef: RefObject<HTMLDivElement | null>;
  qrFilename: string;
  copied: boolean;
  copy: (value: string) => Promise<boolean>;
  eip681Uri: string;
  eip681Copied: boolean;
  eip681Copy: (value: string) => Promise<boolean>;
  settings: QrSettings;
  payMode: PayMode;
  chain: Chain;
  deployment: TokenDeployment;
  effectiveReceiver: Address | null;
  device: StoreDeviceMode['device'];
  onReissueStoreQr: () => Promise<void>;
  onShowNormalQr: () => Promise<void>;
  normalQrHasFee: boolean;
  normalQrFeeShown: boolean;
  recoverBillAmount: bigint | null;
  recoverGasMode: GasMode;
  incomingStatus: IncomingPaymentStatus;
  receivedWei: bigint;
}) {
  const t = useTranslations('QrGenerator');
  const sdState = device.state;
  return (
    <QrPreviewModal
      open={open}
      convertExpired={dimmed}
      onClose={onClose}
      labels={{
        title: t('qrModalTitle'),
        close: t('qrModalClose'),
        convertExpired: converted ? t('qrModalConvertExpired') : undefined,
        eyebrow: t('posterEyebrow'),
        print: t('printPoster'),
        copy: t('qrCopy'),
        copied: t('qrCopied'),
        downloadSvg: t('downloadSvg'),
        downloadPng: t('downloadPng'),
        // お店負担の QR は端末が通信して送るので「圏外でも提示できます」は出さない。
        localGenNote: storeQr ? undefined : t('localGenNote'),
        payTo: t('qrPayTo'),
        showUrl: t('qrShowUrl'),
        step1: t('posterStepScan'),
        step2: t('posterStepConfirm'),
        step3: t('posterStepDone'),
      }}
      qrValue={storeQr ? storeQr.url : payUrl}
      qrRef={qrRef}
      storeName={settings.storeName.trim() || t('posterDefaultStoreName')}
      amountText={storeQr ? storeQr.amountText : amountLabelText}
      payModeBadge={storeQr ? { text: t('storeDevice.posterBadge'), tone: 'gasless' } : {
        text:
          payMode === 'gasless'
            ? t('posterPayModeGasless')
            : settings.chain === 'arc' ? t('posterPayModeArc') : t('posterPayModeStandard', {
                nativeToken: chain.nativeCurrency.symbol,
              }),
        tone: payMode === 'gasless' ? 'gasless' : 'standard',
      }}
      // お店負担の QR は画面に表示している間だけ使える (印刷・保存・URL のコピー・互換 QR は出さない)。
      {...(storeQr
        ? { hideUrl: true, actionsNote: t('storeDevice.actionsNote') }
        : {
            copied,
            onCopy: () => copy(payUrl),
            onPrint: () => window.print(),
            onDownloadSvg: () => downloadSvg(`${qrFilename}.svg`, qrRef),
            onDownloadPng: () => downloadPng(`${qrFilename}.png`, qrRef),
          })}
      deviceStatus={
        (env.enableStoreGasWallet && sdState.phase !== 'idle') || normalQrFeeShown ? (
          <>
            {env.enableStoreGasWallet && sdState.phase !== 'idle' && (
              <StoreDeviceRegisterStatus
                state={sdState}
                formatAmount={formatStoreDeviceAmount}
                onCheckNow={() => void device.checkNow()}
                onRetry={device.retry}
                onReissue={() => void onReissueStoreQr()}
                onShowNormal={() => void onShowNormalQr()}
                {...(normalQrHasFee ? { normalQrFeeNote: t('storeDevice.normalQrFeeNote') } : {})}
                onDismiss={device.dismiss}
              />
            )}
            {/* お店負担から通常の QR に切り替えたとき、その QR の利用料 (店舗負担) を QR の画面の中で開示する
                (会計の画面の開示は全画面の QR の裏に隠れるため・第 7 回レビュー D4)。 */}
            {normalQrFeeShown && (
              <RecoverFeeNotice
                billAmount={recoverBillAmount}
                chainId={deployment.chainId}
                gasMode={recoverGasMode}
                tone="neutral"
                groupDigits
              />
            )}
          </>
        ) : undefined
      }
      note={settings.posterNote.trim() || t('posterDefaultNote')}
      chainText={tokenChainLabelText}
      receiverShort={
        effectiveReceiver ? shortAddress(effectiveReceiver) : ''
      }
      // ポスターを「読まずに分かる」形にする token/chain 情報 (labels-as-props)。
      // chainSlug は public/chains/{slug}.svg と一致 (settings.chain = ChainSlug)。
      asset={{
        tokenSymbol: settings.token,
        chainSlug: settings.chain,
        chainLabel: chain.name,
      }}
      eip681={
        eip681Uri && !storeQr
          ? {
              uri: eip681Uri,
              copied: eip681Copied,
              onCopy: () => eip681Copy(eip681Uri),
              title: t('eip681Title'),
              badge: t('eip681SummaryBadge'),
              description: t('eip681Description'),
              copy: t('eip681Copy'),
              copiedLabel: t('eip681Copied'),
            }
          : undefined
      }
      // 着金検知ヒント (advisory)。watching=監視中 / received=おおよその着金検知。
      // idle (未監視・固定額でない等) は prop を渡さず非表示。received は受信額を
      // 表示通貨でフォーマットして添える (正本は Explorer・ここはあくまでヒント)。
      paymentStatus={
        incomingStatus === 'received'
          ? {
              state: 'received' as const,
              text: t('paymentReceived', {
                amount: formatTokenAmount(receivedWei, deployment),
              }),
              note: t('paymentReceivedNote'),
            }
          : incomingStatus === 'watching'
            ? { state: 'watching' as const, text: t('paymentWatching'), note: t('paymentWatchingNote') }
            : undefined
      }
    />
  );
}
