// x402 facilitator: 加盟店 resource 登録 (SIWE 認証・owner=接続ウォレット)。
//   POST → resource を登録し { resource, paywallSnippet } を返す。
//   GET  → owner の resource 一覧 { resources } を返す。
// flag OFF は 404。OpenPay 自身の resource は registry を経由せず discovery が生成する。

import { NextResponse } from 'next/server';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import { arcPayToRejection } from '@/lib/x402/arcPayToReachability';
import { isFreelyAccessible, probeGateDetailed } from '@/lib/x402/moderation';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';
import { gateAcceptMismatch, registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import {
  checkResourceWalletRateLimit,
  RESOURCE_BODY_MAX_BYTES,
  RESOURCE_RATE_LIMIT_WINDOW_SEC,
} from '@/lib/x402/resourceRequestGuards';
import {
  parseResourceInput,
  createResource,
  listResourcesForMerchant,
  countMerchantResources,
  MAX_RESOURCES_PER_MERCHANT,
} from '@/lib/x402/registry';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;
  const resources = await listResourcesForMerchant(session.address);
  if (resources === null) {
    logger.warn('x402.facilitator.resource_list_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  // スニペットは owner の出品 ID・受取先・URL から決定的に再生成できる。登録時 1 回きりだった表示を owner 一覧から
  // いつでも再取得できるようにする (加盟店の実組み込みで「もう一度見たい」が発生)。
  return NextResponse.json({
    resources: resources.map((r) => ({
      ...r,
      paywallSnippet: buildPaywallSnippet(r.url, { resourceId: r.id, expectedRecipient: r.payTo, dualRail: !!r.usdc, expectedUsdcRecipient: r.usdc?.payTo }),
    })),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const csrf = rejectCrossOriginWrite(req, { json: true });
  if (csrf) return csrf;
  if (
    !(await checkIpRateLimit(
      'x402-resource-write',
      hashIpBucket(clientIp(req)),
      30,
      60,
    ))
  ) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  if (!(await checkResourceWalletRateLimit(session.address))) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(RESOURCE_RATE_LIMIT_WINDOW_SEC) },
      },
    );
  }

  const body = await readJsonBodyCapped(req, RESOURCE_BODY_MAX_BYTES);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  // 新規登録は出品の正当性表明 (attested:true) を必須にする (権利 + 支払いゲートの実装)。
  const parsed = parseResourceInput(body.value, session.address, {
    requireAttestation: true,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  // owner ごとの登録数 soft cap (濫用ガード)。soft-delete 済も数える (create→delete 反復で KV を
  // 無制限に増やさせない)。KV エラーは null → 0 件と誤認して cap を bypass させず 503。
  const count = await countMerchantResources(session.address);
  if (count === null) {
    logger.warn('x402.facilitator.resource_count_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  if (count >= MAX_RESOURCES_PER_MERCHANT) {
    return NextResponse.json({ error: 'too_many_resources' }, { status: 429 });
  }

  // Arc に同意した出品の受取先がコントラクトなら断る (Arc の売上を引き出せない受取先・plans/arc-gateway-payout.md)。
  // 下の 2 つの probe (各 5 秒まで) と並行に走らせ、保存の前に結果を見る (順に待つと route の 15 秒を超えうる)。
  // 読むだけの検査で例外を出さないので、probe で先に返すときに待たずに残しても副作用は無い。
  const arcCheck = arcPayToRejection(parsed.input.usdc, undefined, startedAt);

  // モデレーション: 無料で公開されている URL の価格付き登録を弾く (probe で 200 を確認したら拒否)。
  // 402/401/403/エラー/タイムアウトは通す (fail-open)。private/loopback は parseResourceInput で既に排除。
  if (await isFreelyAccessible(parsed.input.url)) {
    const redacted = await redactUrlForTelemetry(parsed.input.url);
    logger.warn('x402.facilitator.resource_not_gated', {
      merchant: session.address,
      resourceOrigin: redacted.origin,
      resourceHash: redacted.hash,
    });
    return NextResponse.json({ error: 'resource_not_gated' }, { status: 400 });
  }

  // ゲート方式の検証: 402 は返すが accepts が OpenPay (forwarder-split/JPYC) でない URL は、
  // 「JPYC で払える」というカタログの約束を守れないため掲載しない (他 facilitator ゲートの
  // ミスマッチ掲載を防ぐ・実加盟店の USDC ゲート登録で発覚)。未登録では pin する ID がないため、
  // 起動不能なスニペットを加盟店へ渡さない。
  const gate = await probeGateDetailed(parsed.input.url);
  if (gate.result === 'foreign') {
    return NextResponse.json(
      {
        error: 'gate_not_openpay',
      },
      { status: 422 },
    );
  }

  // OpenPay 方式の 402 でも、その JPYC accept の受取先 (extra.openpay.merchant)・チェーン・JPYC・forwarder が
  // 登録と違う URL は掲載しない (E-2: 他人の 402 をそのまま使った偽の掲載・別の受取先や testnet を向いた
  // ゲートの設定ミス)。わざと登録の受取先を返す偽のゲートは止められない (照合の範囲は registrationGateMatch.ts)。
  if (gate.result === 'openpay') {
    const mismatch = gateAcceptMismatch(gate.accepts, registrationAcceptExpectation(parsed.input.payTo));
    if (mismatch) {
      const redacted = await redactUrlForTelemetry(parsed.input.url);
      logger.warn('x402.facilitator.gate_accept_mismatch', {
        merchant: session.address,
        mismatch,
        resourceOrigin: redacted.origin,
        resourceHash: redacted.hash,
      });
      return NextResponse.json({ error: 'gate_accept_mismatch', mismatch }, { status: 422 });
    }
  }

  const arcRejection = await arcCheck;
  if (arcRejection) return NextResponse.json({ error: arcRejection.error }, { status: arcRejection.status });

  // 判定不能 'unknown' (404・3xx・timeout・5xx 等) は登録を受けるが、最初の再検証が OpenPay の 402 を確かめるまで
  // 公開の一覧に出さない (hidden + pendingFirstVerification・plans/full-review-2026-10-30.md Q5)。拒否はしない:
  // SDK / スニペットのゲートは出品 ID が無いと 402 を返せないので、「登録して ID を得る → ゲートを置く」の順に
  // なる (ゲートの README の「仮の値で 500 のまま登録 → 実際の値で再デプロイ」もこの順)。
  const id = crypto.randomUUID();
  const created = await createResource(parsed.input, id, Date.now(), {
    pendingFirstVerification: gate.result === 'unknown',
  });
  if (!created.ok) {
    if (created.reason === 'url_taken') {
      return NextResponse.json({ error: 'url_taken' }, { status: 409 });
    }
    // 上の soft cap pre-check 通過後に並列 POST が cap に達したレースは createResource (原子的 cap) が
    // too_many で弾く。invalid_url は保存層でも予約 origin を守る invariant、それ以外は KV エラー。
    if (created.reason === 'invalid_url') {
      return NextResponse.json({ error: 'invalid_url' }, { status: 400 });
    }
    if (created.reason === 'too_many') {
      return NextResponse.json({ error: 'too_many_resources' }, { status: 429 });
    }
    logger.warn('x402.facilitator.resource_create_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  const resource = created.resource;

  // paywall スニペット: 外部サーバーがコピペで動く自己完結ゲート (旧: リポ内 import 前提の
  // 骨子例 → 実加盟店で動かず差し替え)。
  const paywallSnippet = buildPaywallSnippet(resource.url, {
    resourceId: resource.id,
    expectedRecipient: resource.payTo,
    dualRail: !!resource.usdc,
    expectedUsdcRecipient: resource.usdc?.payTo,
  });

  return NextResponse.json({ resource, paywallSnippet }, { status: 201 });
}
