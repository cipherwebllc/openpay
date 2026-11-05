'use client';

// /checkout (CheckoutForm) の relay の状態の案内: 混雑の先回り (B1 Layer B)・送信結果の確認中 (結果不明)・IP の混雑。
// CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。出すかどうかの判定 (relayPreflightActive・
// relayAmbiguous・relayIpRateLimited) と、ボタンで呼ぶ処理 (通常決済への切り替え・同じ payload の再確認 / 再送) は
// CheckoutForm が決めて渡し、ここは受け取って描くだけ。状態機械・金額・経路の制御はここに持ち込まない (掟 12・15)。
// 完了後に出さない (!completed) のも CheckoutForm 側。描画は tests/components/RelayStatusBanners.test.tsx が状態ごとに固定する。
//
// relay の API 失敗の banner (B1 Layer A) は汎用のエラー枠と三項で入れ替わる (全経路のエラー枠と絡む) ので CheckoutForm に残す。

import { useTranslations } from 'next-intl';
import type { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { RelayFallbackBanner } from '../RelayFallbackBanner';
// CheckoutForm と同じ lazy wrapper (読み込みの状態を共有する・./paymentStatusPanelLazy.ts の冒頭)。
import { PaymentStatusPanel } from './paymentStatusPanelLazy';

type Props = {
  /** B1 Layer B: relayer が degraded で、まだ送っていない (CheckoutForm の relayPreflightActive)。 */
  relayPreflightActive: boolean;
  /** 通常決済に切り替えたあとに自分で払うガスのネイティブトークン (POL / KAIA / ETH 等)。 */
  nativeToken: string;
  /** 通常決済への切り替え (CheckoutForm の switchToStandard・二重払いを防ぐ拒否はそちらにある)。 */
  onSwitchToStandard: () => void;
  /** relay の送信結果が不明 (deriveCheckoutGuards の relayAmbiguous・今の経路とは独立)。 */
  relayAmbiguous: boolean;
  /** relay の早期 IP 制限 (deriveCheckoutGuards の relayIpRateLimited)。null なら出さない。 */
  relayIpRateLimited: { retryAfterSeconds: number | null } | null;
  /** 文言とボタンの出し分けに読む relay の値と、ボタンで呼ぶ処理 (useJpycEip3009Payment の戻り値のまま)。 */
  relay: Pick<
    ReturnType<typeof useJpycEip3009Payment>,
    'recoveryState' | 'isPending' | 'retrySamePayload' | 'retryRelay'
  >;
};

export function RelayStatusBanners({
  relayPreflightActive,
  nativeToken,
  onSwitchToStandard,
  relayAmbiguous,
  relayIpRateLimited,
  relay,
}: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <>
      {/* B1 Layer B (preflight): relayer degraded は additive banner で出す (Layer A と違い汎用
          error box を抑止しない・pre-submit 検証エラー[店主受取0 等]を隠さない・Codex P1)。 */}
      {relayPreflightActive && (
        <RelayFallbackBanner
          message={t('relayDegradedPreflight')}
          nativeToken={nativeToken}
          onSwitchToStandard={onSwitchToStandard}
        />
      )}

      {/* ambiguity latch 中は同一 payload の再確認だけを許可し、standard fallback / 新署名を封鎖。 */}
      {relayAmbiguous && (
        <PaymentStatusPanel
          title={t('responseUnknownTitle')}
          body={
            relay.recoveryState === 'auto'
              ? t('responseUnknownAutoBody')
              : t('responseUnknownBody')
          }
          titleWithIcon
          showSpinner={relay.recoveryState === 'auto'}
          actionLabel={
            relay.recoveryState === 'auto'
              ? undefined
              : t('responseUnknownRetryButton')
          }
          actionDisabled={
            relay.recoveryState === 'auto' ? undefined : relay.isPending
          }
          onAction={
            relay.recoveryState === 'auto'
              ? undefined
              : relay.retrySamePayload
          }
        />
      )}

      {/* relay IP rate limit: idem 確認前の 429 なので main Pay / standard fallback / 再署名を
          封鎖し、保持済みの同一署名 payload の再 POST だけを許可する。 */}
      {relayIpRateLimited && !relayAmbiguous && (
        <PaymentStatusPanel
          title={t('ipRateLimitedTitle')}
          body={
            relayIpRateLimited.retryAfterSeconds === null
              ? t('ipRateLimitedBody')
              : t('ipRateLimitedBodyWithRetryAfter', {
                  seconds: relayIpRateLimited.retryAfterSeconds,
                })
          }
          actionLabel={t('ipRateLimitedRetryButton')}
          actionDisabled={relay.isPending}
          onAction={relay.retryRelay}
        />
      )}
    </>
  );
}
