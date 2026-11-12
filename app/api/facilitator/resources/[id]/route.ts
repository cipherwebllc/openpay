// x402 facilitator: 登録済み resource の **編集 (PATCH)** + **無効化 (DELETE)**。
//   PATCH  → owner が url/description/priceJpyc/category/payTo を更新 → { resource }。URL を替える編集は新規登録と
//            同じ扱い (替えた先の 402 を照合・不一致は 422・確かめられなければ最初の再検証まで公開の一覧に出さない)。
//   DELETE → owner が soft-delete (active:false) → { ok:true }。公開カタログ + owner 一覧から消えるが
//            データは KV に残す (settlement の resourceId 参照・監査)。
// **owner 認可が要**: SIWE セッション === resource.merchant のときだけ更新/削除を許可する (registry が
// forbidden で弾く)。特に payTo (送金先) を他人に書き換えさせない。flag OFF は 404。

import { NextResponse } from 'next/server';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import {
  parseResourceInput,
  updateResource,
  deactivateResource,
  getResource,
} from '@/lib/x402/registry';
import { arcPayToRejection } from '@/lib/x402/arcPayToReachability';
import { isFreelyAccessible, probeGateDetailed } from '@/lib/x402/moderation';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';
import { gateAcceptMismatch, registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import {
  checkResourceWalletRateLimit,
  RESOURCE_BODY_MAX_BYTES,
  RESOURCE_RATE_LIMIT_WINDOW_SEC,
} from '@/lib/x402/resourceRequestGuards';

export const runtime = 'nodejs';
export const maxDuration = 15;

function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}
function forbidden() {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!env.enableX402Facilitator) return notFound();
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
  const { id } = await params;

  // **owner 認可を moderation probe より先に行う**: 他人の id を知る SIWE ユーザに、任意 URL を
  // OpenPay 経由で server-side probe させない (SSRF 踏み台化を防ぐ)。merchant は不変なので事前 read で
  // 判定でき、最終的に updateResource の CAS が再検証する (TOCTOU 無し)。
  const existing = await getResource(id);
  if (existing && existing.merchant.toLowerCase() !== session.address.toLowerCase()) {
    return forbidden();
  }

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
  const parsed = parseResourceInput(body.value, session.address);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });

  // 新規登録と同じ Arc 受取先の検査。同意済みで受取先も同じ編集は検査しない (existing=null なら検査する)。
  // 新規登録と同じく、下の probe と並行に走らせて更新の前に結果を見る (順に待つと route の 15 秒を超えうる)。
  const arcCheck = arcPayToRejection(parsed.input.usdc, existing?.usdc, startedAt);

  // 差し替え URL の moderation は **owner かつ resource 存在時のみ** 実行 (probe を owner に限定)。
  // existing=null (未存在/outage) は probe せず updateResource の判定 (not_found/storage) に委ねる。
  if (existing && (await isFreelyAccessible(parsed.input.url))) {
    const redacted = await redactUrlForTelemetry(parsed.input.url);
    logger.warn('x402.facilitator.resource_not_gated', {
      id,
      merchant: session.address,
      resourceOrigin: redacted.origin,
      resourceHash: redacted.hash,
    });
    return NextResponse.json({ error: 'resource_not_gated' }, { status: 400 });
  }

  // 新規登録と同じゲート方式検証 (URL を他 facilitator ゲートへ差し替えるミスマッチを防ぐ)。
  // GET は今までと同じ 1 回で、その 402 の accepts も読む (下の URL 変更の照合に使う)。
  const gate = existing ? await probeGateDetailed(parsed.input.url) : null;
  if (gate?.result === 'foreign') {
    return NextResponse.json(
      {
        error: 'gate_not_openpay',
        paywallSnippet: buildPaywallSnippet(parsed.input.url, {
          resourceId: id,
          expectedRecipient: parsed.input.payTo,
          dualRail: !!parsed.input.usdc,
          expectedUsdcRecipient: parsed.input.usdc?.payTo,
        }),
      },
      { status: 422 },
    );
  }

  // URL を替える編集は新規登録と同じ扱いにする (B3-3: 検証済みで公開中の掲載が、照合を通っていない URL を公開のまま指す
  // 経路を断つ)。替えた先が OpenPay 方式の 402 を返したら、その JPYC accept を登録と同じ照合に通し、合わなければ保存しない。
  // 期待値の受取先は保存した後の掲載の payTo (この編集が payTo も替えるなら新しい payTo)。
  // URL が変わらない編集は不一致でも断らない: 出品者のゲート (SDK) は掲載の payTo を読んで 402 を作るので、payTo を替える
  // 編集の時点ではまだ古い payTo の 402 しか返せず、必ず不一致になる (その 402 は毎時の再検証が新しい payTo で照合する)。
  const mismatch = gate?.result === 'openpay'
    ? gateAcceptMismatch(gate.accepts, registrationAcceptExpectation(parsed.input.payTo))
    : null;
  if (existing && existing.url !== parsed.input.url && mismatch) {
    const redacted = await redactUrlForTelemetry(parsed.input.url);
    logger.warn('x402.facilitator.gate_accept_mismatch', {
      id,
      merchant: session.address,
      mismatch,
      resourceOrigin: redacted.origin,
      resourceHash: redacted.hash,
    });
    return NextResponse.json({ error: 'gate_accept_mismatch', mismatch }, { status: 422 });
  }

  const arcRejection = await arcCheck;
  if (arcRejection) return NextResponse.json({ error: arcRejection.error }, { status: arcRejection.status });

  // 替えた先の OpenPay の 402 を確かめていない URL 変更 (判定不能 'unknown': 404・3xx・timeout・5xx 等) は、新規登録の
  // 判定不能と同じく保存は受けるが、最初の再検証が照合つきの 402 を確かめるまで公開の一覧に出さない (hidden +
  // pendingFirstVerification・ID の照会は返るので出品者のゲートは動く)。
  // 渡すのは「この URL と payTo で、照合の合う OpenPay の 402 を確かめたか」だけで、URL が変わったかは CAS が権威の record で
  // 判定する = URL が変わらない編集は probe の結果によらず今までどおり。上の 422 は事前の読取の URL で判定しているので、
  // 次の 2 つの場合も CAS の側で公開待ちに倒れる (確かめていない URL を公開のまま指させない):
  //   - gate が null (事前の読取が null = 未存在か KV の読取失敗) で probe していないのに、CAS は通った URL 変更
  //     (未存在なら CAS が not_found を返すだけ)。
  //   - probe の間に並行の編集が URL を動かし、事前の読取では「URL は同じ」だったこの編集が CAS では URL 変更になった。
  const result = await updateResource(id, session.address, parsed.input, Date.now(), {
    pendingIfUrlChanged: gate?.result !== 'openpay' || mismatch !== null,
  });
  if (!result.ok) {
    if (result.reason === 'url_taken') {
      return NextResponse.json({ error: 'url_taken' }, { status: 409 });
    }
    if (result.reason === 'not_found') return notFound();
    if (result.reason === 'forbidden') return forbidden();
    logger.warn('x402.facilitator.resource_update_failed', { id, merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ resource: result.resource });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!env.enableX402Facilitator) return notFound();
  const csrf = rejectCrossOriginWrite(req, { json: false });
  if (csrf) return csrf;
  // POST/PATCH と同じ IP limiter (取り下げの連打で KV を使わせない・第 7 回レビュー X1)。
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
  const { id } = await params;

  const result = await deactivateResource(id, session.address);
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound();
    if (result.reason === 'forbidden') return forbidden();
    logger.warn('x402.facilitator.resource_deactivate_failed', { id, merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
