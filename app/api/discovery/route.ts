// x402 facilitator: GET /api/discovery — 公開カタログ (日本向け Bazaar)。
// 登録済の active resource を、AI エージェントが列挙してそのまま支払える JSON で返す
// (各 item に fee 込みの accepts = PaymentRequirements を同梱)。flag OFF は 404。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { listActiveResources } from '@/lib/x402/registry';
import { createJpycPaymentRequirements } from '@/lib/x402/requirements';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { caip2ForChainId } from '@/lib/x402/network';
import {
  FIRST_PARTY_RESOURCES,
  firstPartyAmount,
  firstPartyPayToOrNull,
  firstPartyResourceUrl,
} from '@/lib/x402/firstParty';
import { readFirstPartyVerification } from '@/lib/x402/reverify';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const firstPartyPayToAddr = firstPartyPayToOrNull();
  const firstPartyStatesPromise =
    firstPartyPayToAddr === null
      ? Promise.resolve([])
      : Promise.all(
          FIRST_PARTY_RESOURCES.map(async (resource) => ({
            path: resource.path,
            url: firstPartyResourceUrl(resource),
            read: await readFirstPartyVerification(resource.path),
          })),
        );
  const [resources, firstPartyStates] = await Promise.all([
    listActiveResources(),
    firstPartyStatesPromise,
  ]);
  // KV エラーは null。空カタログ ([]) と区別し、503 を **無キャッシュ** で返す (transient outage の
  // 空応答を edge に焼き付けない・空と誤認させない)。
  if (resources === null) {
    logger.warn('x402.discovery.list_failed', {});
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  if (firstPartyStates.some((state) => !state.read.ok)) {
    logger.warn('x402.discovery.first_party_verification_failed', {});
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  const firstPartyStateByPath = new Map(
    firstPartyStates.map((state) => [
      state.path,
      { url: state.url, state: state.read.ok ? state.read.state : null },
    ]),
  );

  // payTo 未設定 (testnet dev 等) では first-party を並べない — エージェントに
  // 支払えない項目 (accepts: []) を見せる波及を断つ。設定漏れは logger で顕在化する。
  if (firstPartyPayToAddr === null) {
    logger.warn('x402.discovery.first_party_disabled', {
      reason: 'X402_PAY_TO_ADDRESS missing or invalid',
    });
  }
  const buildFirstPartyItems = (payTo: NonNullable<typeof firstPartyPayToAddr>) =>
    FIRST_PARTY_RESOURCES.flatMap((r) => {
      const verificationState = firstPartyStateByPath.get(r.path);
      const state = verificationState?.state;
      const currentVerification =
        state && state.verification?.probedUrl === verificationState?.url
          ? state
          : null;
      if (currentVerification?.hidden === true) return [];
      let accepts: ReturnType<typeof createJpycPaymentRequirements> = [];
      try {
        accepts = createJpycPaymentRequirements({
          amount: firstPartyAmount(r),
          payTo,
          resource: firstPartyResourceUrl(r),
          description: r.description,
          chainId: x402FacilitatorConfig.chainId,
          mimeType: 'application/json',
        });
      } catch (e) {
        // Requirements misconfiguration for one first-party item must not hide other catalog entries.
        logger.warn('x402.discovery.first_party_requirements_failed', {
          path: r.path,
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }
      // Requirements 生成が空配列を返す設定不良も、支払えない商品を広告しないため即時除外する。
      if (accepts.length === 0) return [];
      return [
        {
          resource: firstPartyResourceUrl(r),
          description: r.description,
          category: r.category,
          priceJpyc: r.priceJpyc,
          network: caip2ForChainId(x402FacilitatorConfig.chainId),
          accepts,
          verifiedAt: currentVerification?.verification?.lastOkAt ?? null,
        },
      ];
    });
  const firstPartyItems =
    firstPartyPayToAddr === null ? [] : buildFirstPartyItems(firstPartyPayToAddr);

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
      verifiedAt: r.verification?.lastOkAt ?? null,
    };
  });

  // 公開カタログは AI エージェントがポーリングする read-only エンドポイント。edge (Vercel CDN) で
  // 短期キャッシュし、ポーリング毎の KV ファンアウトを抑える。s-maxage=10 = 最大 10 秒の鮮度
  // (新規登録/無効化/hidden はこの範囲で反映)、stale-while-revalidate=30 = revalidate 中も即応。
  // 再検証による非表示/復帰が最大およそ 40 秒 stale になる点は、3 回の時間閾値に対して受容する。
  // 認証なしの公開データのみなので edge 共有キャッシュは安全 (owner 専用一覧は別 route で無キャッシュ)。
  return NextResponse.json(
    { x402Version: 1, items: [...firstPartyItems, ...items] },
    { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } },
  );
}
