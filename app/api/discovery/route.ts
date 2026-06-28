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
  // KV エラーは null。空カタログ ([]) と区別し、503 を **無キャッシュ** で返す (transient outage の
  // 空応答を edge に焼き付けない・空と誤認させない)。
  if (resources === null) {
    logger.warn('x402.discovery.list_failed', {});
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
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

  // 公開カタログは AI エージェントがポーリングする read-only エンドポイント。edge (Vercel CDN) で
  // 短期キャッシュし、ポーリング毎の KV ファンアウトを抑える。s-maxage=10 = 最大 10 秒の鮮度
  // (新規登録/無効化はこの範囲で反映)、stale-while-revalidate=30 = revalidate 中も即応 (古い値を返す)。
  // 認証なしの公開データのみなので edge 共有キャッシュは安全 (owner 専用一覧は別 route で無キャッシュ)。
  return NextResponse.json(
    { x402Version: 1, items },
    { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } },
  );
}
