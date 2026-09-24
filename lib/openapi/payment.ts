// OpenAPI の支払い情報 (x-payment-info / x-payment-chains) を組み立てる helper。
// 金額は 402 チャレンジと同じ SoT (FIRST_PARTY_RESOURCES・x402FeeBreakdown・x402Config) から
// 導出する (literal を書くと掟 14 のドリフト源になるため)。lib/openapi/document.ts を import しない。
//
// 評価時点: 領域 module の定数 (xxx_OPENAPI_PATHS) から呼ばれる分は module 読み込み時に確定し、
// vanillaHelloPath() から呼ばれる分だけが文書生成ごとに評価される (分割前と同じ)。定数を関数化
// したり逆にしたりすると公開文書が変わる (tests/lib/openapi/documentGolden.test.ts の late-mutation)。

import { x402Config } from '@/lib/x402/config';
import { FIRST_PARTY_RESOURCES } from '@/lib/x402/firstParty';
import { x402FeeBreakdown } from '@/lib/x402/fee';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { caip2ForChainId } from '@/lib/x402/network';

const JPYC_WEI = 10n ** 18n;

/** atomic JPYC → 小数文字列 (末尾 0 を落とす)。表示ではなく機械可読面の金額に使う。 */
function formatJpyc(wei: bigint): string {
  const int = wei / JPYC_WEI;
  const frac = wei % JPYC_WEI;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(18, '0').replace(/0+$/, '')}`;
}

/** 価格はカタログ (FIRST_PARTY_RESOURCES) が権威。スペック側に literal を持たない。 */
export function firstPartyPrice(path: string): string {
  const resource = FIRST_PARTY_RESOURCES.find((r) => r.path === path);
  if (!resource) {
    throw new Error(`openapi: unknown first-party resource ${path}`);
  }
  return resource.priceJpyc;
}

// JPYC は 1 JPYC = 1 円のペッグなので ISO 4217 の JPY で表現できる。amount は買い手が実際に
// 署名する総額 (資源価格 + 買い手上乗せの facilitator 手数料) = 402 の maxAmountRequired と一致。
export function paymentInfo(priceJpyc: string) {
  const { total } = x402FeeBreakdown(BigInt(priceJpyc) * JPYC_WEI);
  return {
    price: { currency: 'JPY', mode: 'fixed', amount: formatJpyc(total) },
    protocols: [
      {
        x402: {
          scheme: 'exact',
          network: caip2ForChainId(x402FacilitatorConfig.chainId),
          asset: 'JPYC',
        },
      },
    ],
  } as const;
}

// Arc rail (ENABLE_X402_ARC_GATEWAY・DEPLOY_CHECKLIST §14.8) が ON のとき、first-party の USDC 有料 API は
// Arc の USDC (Circle Gateway x402 facilitator) でも払える。402 の v2 accepts と機械可読面を一致させるため、
// flag に連動して 2 つ目の protocol と chain を載せる (OFF なら従来と 1 バイトも変わらない)。
// network は Base と同じく本番 (servers = open-pay.jp) の mainnet 固定。
function arcRailEnabled(): boolean {
  return x402Config.arcGateway.enabled;
}

export function usdcPaymentChains(): string[] {
  return arcRailEnabled() ? ['Base', 'Arc'] : ['Base'];
}

// vanilla x402 (USDC/Base) 直接販売用。JPYC 版と違い OpenPay 手数料が乗らないため、
// amount は表示価格そのもの。network は本番 (servers = open-pay.jp) の Base mainnet 固定。
export function usdcPaymentInfo(amountUsd: string) {
  return {
    price: { currency: 'USD', mode: 'fixed', amount: amountUsd },
    protocols: [
      { x402: { scheme: 'exact', network: 'eip155:8453', asset: 'USDC' } },
      ...(arcRailEnabled()
        ? [
            {
              x402: {
                scheme: 'exact',
                network: 'eip155:5042',
                asset: 'USDC',
                facilitator: 'circle-gateway',
                extra: { name: 'GatewayWalletBatched', version: '1' },
              },
            },
          ]
        : []),
    ],
  };
}
