// x402 facilitator: GET /api/discovery — 公開カタログ (日本向け Bazaar)。
// 登録済の active resource を、AI エージェントが列挙してそのまま支払える JSON で返す
// (各 item に fee 込みの accepts = PaymentRequirements を同梱)。flag OFF は 404。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { listActiveResources } from '@/lib/x402/registry';
import { createJpycPaymentRequirements } from '@/lib/x402/requirements';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const resources = await listActiveResources();
  const items = resources.map((r) => {
    // priceJpyc (human 整数) → atomic。accepts は facilitator 未準備 (forwarder/feeReceiver 欠落) や
    // 不正 price では生成不能なので per-item で握りつぶし [] にする (カタログ自体は出す)。
    let accepts: ReturnType<typeof createJpycPaymentRequirements> = [];
    try {
      const amount = BigInt(r.priceJpyc) * 10n ** 18n;
      accepts = createJpycPaymentRequirements({
        amount,
        payTo: r.payTo as `0x${string}`,
        resource: r.url,
        description: r.description,
        chainId: x402FacilitatorConfig.chainId,
      });
    } catch (e) {
      logger.warn('x402.discovery.requirements_failed', {
        id: r.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      resource: r.url,
      description: r.description,
      category: r.category,
      priceJpyc: r.priceJpyc,
      network: r.network,
      accepts,
    };
  });

  return NextResponse.json({ x402Version: 1, items });
}
