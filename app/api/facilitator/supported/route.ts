// x402 facilitator: GET /api/facilitator/supported
// 対応する (scheme, network, asset) と OpenPay forwarder 分割の記述子を返す。
// flag OFF (env.enableX402Facilitator=false) は 404 で完全 inert。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { caip2ForChainId } from '@/lib/x402/network';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { resolveDeployment } from '@/lib/tokens';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { receiptSignerAddress } from '@/lib/x402/receipt';
import { x402FeeDisclosureDivergence } from '@/lib/legal';

export const runtime = 'nodejs';

// 起動時: 実 x402 料率 (env 由来) が法務文書で開示した数値 (DISCLOSED_X402_FEE) と食い違っていれば warn。
// 運営が文書を改定せず env だけ変えると開示が黙って嘘になるため Sentry で可視化する (決済は止めない)。
{
  const divergence = x402FeeDisclosureDivergence(
    x402FacilitatorConfig.feeBps,
    x402FacilitatorConfig.feeFloorWei,
  );
  if (divergence) {
    logger.warn('x402.facilitator.fee_disclosure_divergence', { detail: divergence });
  }
}

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // forwarder / JPYC が設定済の chain のみ広告する (未設定 chain は settle 不能なので出さない)。
  const kinds = x402FacilitatorConfig.supportedChainIds.flatMap((chainId) => {
    const jpyc = resolveDeployment('jpyc', chainId);
    const forwarder = configuredJpycForwarderFor(chainId);
    if (!jpyc || !forwarder) return [];
    return [
      {
        x402Version: 1,
        scheme: 'exact' as const,
        network: caip2ForChainId(chainId),
        asset: jpyc.address,
        extra: {
          assetTransferMethod: 'eip3009' as const,
          name: JPYC_V3_ASSET.eip712.name,
          version: JPYC_V3_ASSET.eip712.version,
          decimals: jpyc.decimals,
          // OpenPay 1% 分割 (買い手上乗せ・seller は表示額受領・feeReceiver が手数料受領)。
          feeModel: {
            bps: x402FacilitatorConfig.feeBps,
            floor: x402FacilitatorConfig.feeFloorWei.toString(),
          },
          openpay: {
            mode: 'forwarder-split' as const,
            forwarder,
            feeReceiver: x402FacilitatorConfig.feeReceiver,
          },
        },
      },
    ];
  });
  return NextResponse.json({
    x402Version: 1,
    kinds,
    // 受領証明 (receipt) の署名者アドレス (公開鍵相当)。第三者がオフラインで receipt を検証する際の
    // 期待 signer。鍵未設定なら null (receipt 非発行)。
    receiptSigner: receiptSignerAddress(),
  });
}
