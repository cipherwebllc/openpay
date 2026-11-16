// Shared public projection: never expose owner-only registry/moderation fields.
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { warnThrottled } from '@/lib/warnThrottle';
import type { X402Resource } from './registry';
import { createJpycPaymentRequirements } from './requirements';
import { x402FacilitatorConfig } from './facilitatorConfig';

function updatedAtIso(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  // 旧 record の不正な付加値 1 件がカタログ全体の応答を巻き込まないため、変換不能なら省略する。
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// accepts を作れなかったときの警告の出し方。'every' = 失敗のたびに出す (カタログ・既定)。
// 'throttled' = warnThrottled を通す (GET /api/discovery/[id] = KV の IP 制限を置かない公開の GET・lib/warnThrottle.ts)。
type RequirementsFailedWarn = 'every' | 'throttled';

// カタログ (GET /api/discovery の .map(publicDiscoveryItem)) とテストが使う形。引数は 1 つのまま: .map に直接
// 渡すので、2 つ目の引数を足すと index が入る。失敗のたびに警告する。
export function publicDiscoveryItem(r: X402Resource) {
  return discoveryItem(r, 'every');
}

// GET /api/discovery/[id] 用。中身は publicDiscoveryItem と同じで、accepts を作れない警告だけ 60 秒に 1 回まで。
export function publicDiscoveryItemForLookup(r: X402Resource) {
  return discoveryItem(r, 'throttled');
}

function discoveryItem(r: X402Resource, requirementsFailedWarn: RequirementsFailedWarn) {
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
    const fields = {
      id: r.id,
      error: e instanceof Error ? e.message : String(e),
    };
    if (requirementsFailedWarn === 'throttled') {
      warnThrottled('x402.discovery.requirements_failed', fields);
    } else {
      logger.warn('x402.discovery.requirements_failed', fields);
    }
  }
  const updatedAt = updatedAtIso(r.updatedAt);
  return {
    id: r.id,
    resource: r.url,
    ...(r.title ? { title: r.title } : {}),
    ...(r.trigger ? { trigger: r.trigger } : {}),
    description: r.description,
    category: r.category,
    priceJpyc: r.priceJpyc,
    ...(r.docsUrl ? { docsUrl: r.docsUrl } : {}),
    ...(r.license ? { license: r.license } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    // dual-rail の USDC/Base 面 (表示用・価格とサービス名)。リレー flag OFF 中は出さない —
    // 「USDC 対応」と見せて実際は買えない期待違いを作らないため。
    ...(env.enableX402DualRail && r.usdc
      ? { usdc: { priceUsd: r.usdc.priceUsd, serviceName: r.usdc.serviceName } }
      : {}),
    network: r.network,
    accepts,
    verifiedAt: r.verification?.lastOkAt ?? null,
  };
}
