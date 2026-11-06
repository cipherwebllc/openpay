// 「売上をほかのウォレットへ移す」の relay endpoint (plans/store-sales-move.md §2.1・P1)。
//
// ウォレットに JPYC だけがあって POL (ガス代) が無いお店が、売上を自分の別のウォレットへ移す。仕組みはチップと同じ recover
// の経路: お店が receiveWithAuthorization (to = forwarder・nonce = 分割のコミットメント) に 1 回署名 → OpenPay の relayer が
// Eip3009Forwarder.settle を送る → 送り先へ移す額 (merchantValue)・OpenPay へ利用料 (feeValue = relay の gas floor)。
//
// 既存の /api/relay/jpyc (決済・チップ・注文リンク) の制御フローは一切変えない (掟 12)。この route は export 済みの部品を
// つなぎ直すだけで、入口の守りは既存と同じものを同じ共有キーで通す:
//   - admission (IP・relay-admission の枠を /api/relay/jpyc・CSV パス・facilitator と共有)
//   - settleViaForwarder = forwarder の health + verifyForwarderSettle (server 権威の利用料・境界・署名・残高) +
//     authorizationState + relayBroadcast (冪等 relay:idem: と入口をまたぐ relay:recover:idem:・払い元の rate limit relay:rl:・
//     日次予算 relay:budget:・ガスの上限)
//   - hosted intent の gate (checkHostedIntentSettleAdmission・lib/x402/purchaseSettleGate.ts の「入口を新設したら必ず配線」)
//   - mainnet の gas_ceiling_required / kv_required
//   - 結果 → HTTP 応答は makeRespond('relay.jpyc') (応答の形も、失敗のログのイベント名 = 既存の Sentry alert も同じ)
//
// この route だけの決まり:
//   - flag (NEXT_PUBLIC_ENABLE_SALES_MOVE) OFF は 404 (完全 inert)。
//   - Polygon (137) と Amoy (80002) だけ。recover (forwarder) の経路だけで、free モードへは倒さない。
//   - 利用料 = relayGasFeeValue(chainId) (floor) に固定。gasMode・feeKind・tipMessage は受け取らない (送られても読まない)。
//   - 送り先 (merchant) の拒否: 送り元と同じ・relayer・JPYC の token contract。forwarder・feeReceiver・0 アドレスは
//     verifyForwarderSettle が既存のコード (merchant_is_forwarder・merchant_is_fee_receiver・zero_merchant) で拒む。
//   - 移す額 (merchantValue) ≥ 1 JPYC。上限は既存の MAX_VALUE (verifyForwarderSettle の value_exceeds_max)。
//   - 記録: 月次メトリクス sales_move (relay_jpyc には数えない) と、送り先ごとの送り元の数 (salesMoveAbuse)。push・チップの
//     メッセージ・1% 回避の集計は呼ばない (決済でもチップでもない)。
//
// 受容した限界 (§2.1・§5): 署名に route の区別は入らない。同じ署名は /api/relay/jpyc にも出せ、通れば記録だけが決済・チップ側
// になる (逆も同じ・オンチェーンの結果は同じで資金は安全)。よって最低額と同一アドレスの拒否は画面の守りで、既存 route からは
// 迂回できる (今の「自分宛てのチップ」と同じ)。同じ署名を両方へ並行に出しても、冪等の claim (同じ relay:idem: と
// relay:recover:idem:) で broadcast は 1 本になる。
//
// payload は /api/relay/jpyc の recover の形と同じ (merchant = 送り先・merchantValue = 移す額・feeValue = 利用料)。
// status の照会 (/api/relay/jpyc/status) もその形のまま使え、同じ relay:idem: を読むので、この route の tx も復旧できる。

import { NextResponse } from 'next/server';
import { getAddress, isAddress, isAddressEqual, isHex, type Hex } from 'viem';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isKvConfigured } from '@/lib/kv';
import { readTextBodyCapped } from '@/lib/httpBodyCap';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { recordMetricAfterResponse } from '@/lib/metrics';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES, isDec, makeRespond } from '@/lib/relay/relayRoute';
import {
  PROVIDER,
  MAINNET_CHAINS,
  RELAYER_ADDRESS,
  jpycAddressFor,
  relayMaxGasCostWei,
} from '@/lib/relay/relayProvider';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import {
  settleViaForwarder,
  feeReceiverFor,
} from '@/lib/relay/forwarderSettleService';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import { isSalesMoveChain, SALES_MOVE_MIN_VALUE_WEI } from '@/lib/relay/salesMove';
import { recordSalesMoveSenderAfterResponse } from '@/lib/relay/salesMoveAbuse';
import { checkHostedIntentSettleAdmission } from '@/lib/x402/purchaseSettleGate';

export const runtime = 'nodejs';

// /api/relay/jpyc と同じ prefix: 応答の body/status と、reverted・pending・relay_error のログのイベント名
// (既存の Sentry alert の対象) をそろえる。
const respond = makeRespond('relay.jpyc');

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status });

export async function POST(req: Request): Promise<NextResponse> {
  // flag OFF は endpoint 自体を公開しない (完全 inert・status route の未構成と同じ形)。
  if (!env.enableSalesMove) {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  // 以下、relay 未構成・admission・body の読み取りは /api/relay/jpyc と同じ応答。
  if (!env.enableJpycEip3009 || PROVIDER === null) {
    return json({ ok: false, error: 'relay_not_configured' }, 503);
  }
  if (
    !(await checkIpRateLimit(
      'relay-admission',
      hashIpBucket(clientIp(req)),
      120,
      60,
    ))
  ) {
    // IP 単位の濫用を署名検証/RPC 前で止め、relayer 資源と daily budget への波及を断つ (枠は既存 relay と共有)。
    return NextResponse.json(
      { error: 'ip_rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const bodyRead = await readTextBodyCapped(req, MAX_BODY_BYTES);
  if (!bodyRead.ok && bodyRead.reason === 'unreadable') {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (!bodyRead.ok) {
    return json({ ok: false, error: 'payload_too_large' }, 413);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyRead.text);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (raw === null || typeof raw !== 'object') {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }
  const chainId = raw.chainId;
  if (!isSalesMoveChain(chainId)) {
    return json({ ok: false, error: 'unsupported_chain' }, 400);
  }

  // recover は forwarder.settle を自前の relayer EOA で送る (Gelato では送れない)。
  if (PROVIDER !== 'self-host') {
    return json({ ok: false, error: 'relay_not_configured' }, 503);
  }
  // mainnet の前提条件 (/api/relay/jpyc と同じ)。ガスの上限が無いと赤字、KV が無いと冪等が fail-open になり
  // 同じ authorization を二重に submit しうる。
  if (MAINNET_CHAINS.has(chainId)) {
    if (relayMaxGasCostWei(chainId) === 0n) {
      logger.error('relay.jpyc.move.gas_ceiling_required', { chainId });
      return json({ ok: false, error: 'gas_ceiling_required' }, 503);
    }
    if (!isKvConfigured()) {
      logger.error('relay.jpyc.move.kv_required', { chainId });
      return json({ ok: false, error: 'kv_required' }, 503);
    }
  }
  // forwarder 未設定 (または a1 利用料が ON で実効 null) の chain では移せない。
  if (jpycForwarderFor(chainId) === null) {
    logger.warn('relay.jpyc.move.relay_not_configured', { chainId });
    return json({ ok: false, error: 'relay_not_configured' }, 503);
  }

  if (
    !isAddress(raw.from as string) ||
    !isAddress(raw.merchant as string) ||
    !isDec(raw.merchantValue) ||
    !isDec(raw.feeValue) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.intentSalt !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.intentSalt) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }
  const feeReceiver = feeReceiverFor(chainId);
  if (!feeReceiver) {
    return json({ ok: false, error: 'relay_not_configured' }, 503);
  }
  const params: ForwarderSettleParams = {
    from: getAddress(raw.from as string),
    merchant: getAddress(raw.merchant as string),
    merchantValue: BigInt(raw.merchantValue),
    feeReceiver, // server 権威 (client 値は使わない・nonce で client と一致を強制)
    feeValue: BigInt(raw.feeValue),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    intentSalt: raw.intentSalt as Hex,
  };

  // この route だけの拒否 (署名の検証や KV・RPC より前の純チェック): 最低額 (Q2) と、移動にならない送り先 (送り元と同じ)・
  // お店のウォレットではない送り先 (OpenPay のガス用の relayer)・送ったら戻せない送り先 (JPYC の token)。
  if (params.merchantValue < SALES_MOVE_MIN_VALUE_WEI) {
    return json({ ok: false, error: 'amount_below_minimum' }, 400);
  }
  if (isAddressEqual(params.merchant, params.from)) {
    return json({ ok: false, error: 'merchant_is_sender' }, 400);
  }
  if (RELAYER_ADDRESS !== null && isAddressEqual(params.merchant, RELAYER_ADDRESS)) {
    return json({ ok: false, error: 'merchant_is_relayer' }, 400);
  }
  // JPYC の token contract へ送った JPYC は戻せない (forwarder・token に rescue は無い・§1)。
  const jpyc = jpycAddressFor(chainId);
  if (jpyc !== null && isAddressEqual(params.merchant, jpyc)) {
    return json({ ok: false, error: 'merchant_is_token' }, 400);
  }

  // creator-store の hosted intent の署名をこの入口へ転用して hosted CAS を迂回する経路を broadcast 前に閉じる
  // (/api/relay/jpyc と同じ応答・store intent 不在の salt は 1 GET で素通し)。
  const hostedAdmission = await checkHostedIntentSettleAdmission({
    params,
    chainId,
    signature: raw.signature,
  });
  if (hostedAdmission === 'storage') {
    return json({ ok: false, error: 'storage_unavailable' }, 503);
  }
  if (hostedAdmission === 'denied') {
    return json({ ok: false, error: 'hosted_intent_required' }, 409);
  }

  // 利用料は常に relay の gas floor (gasMode を読まない = いつも移す額に上乗せ)。sub-floor の専用枠には入らない
  // (expectedFeeValue === callerFeeFloorValue)。冪等の名前空間は /api/relay/jpyc と同じ relay:idem: (status が読む)。
  const fee = relayGasFeeValue(chainId);
  const result = await settleViaForwarder({
    chainId,
    params,
    signature: raw.signature as Hex,
    rateLimitKeys: [params.from],
    expectedFeeValue: fee,
    callerFeeFloorValue: fee,
    forwarderFor: jpycForwarderFor,
    idemPrefix: 'relay:idem:',
  });
  if (result.kind === 'success') {
    // 月次メトリクスと送り元の数の集計 (運営ヒント)。どちらも応答後 (after) に回る no-throw で、成功済みの応答へ波及しない。
    recordMetricAfterResponse('sales_move');
    recordSalesMoveSenderAfterResponse({
      chainId,
      destination: params.merchant,
      sender: params.from,
    });
  }
  return respond(result, chainId);
}
