// CSV 24時間パス購入の **ガスレス relay** endpoint (POST・nodejs)。店主が POL/KAIA を持たなくても
// 100 JPYC を署名のみで FEE_RECEIVER へ送れるようにする (ガス ~0.3 円は OpenPay 負担)。決済 relay
// (/api/relay/jpyc) を流用せず専用 route にする理由 (plans/csv-pass-v2.md):
//   (a) recover モード時は free body を受けない (b) 決済ログ/メーターを購入で汚染する
//   (c) a1 ゲート (isGaslessRelayBlocked) の誤適用。
//
// body: {chainId, from, value, validAfter, validBefore, nonce, signature} — **`to` は受けない**。
// サーバが auth = {from, to: env.feeReceiver, ...} を構成する (汎用無料 relay 化の悪用を構造的に遮断・
// 別宛先署名は recover で弾かれる)。route 固有の検証:
//   auth.from === session.address (SIWE 束縛・relayer ガスは認証済み wallet のみ) → 403 from_mismatch
//   csvPassPriceWei <= value <= csvPassPriceWei * 10 (少額 overpay のみ許可) → 400 insufficient_value /
//   value_too_large
// 共通検証 (relayJpycAuthorization): validateAuthorization → recover==from → balance ≥ value →
//   authorizationState → idem claim → rate-limit → gas budget → submit → poll。
//
// a1 ゲートは適用しない (宛先=運営 FEE_RECEIVER は isFeePayment 除外と同思想)。決済ログ/billing メーター
// にも記録しない (購入は GMV ではない・台帳は subscribe 側の csvpass:revenue が担う)。logger は
// csvpass.relay.* (relay.jpyc.* と同形)。応答も決済 relay と同形。idem prefix は csvpassrelay:idem: で
// 専用 (rate-limit / 日次予算は relayGuards 内で決済 relay と同一キーを共有 = relayer 資源の上限を回避不可)。

import { NextResponse } from 'next/server';
import { isAddress, isHex, getAddress, type Hex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { csvPassPriceWei } from '@/lib/csvPass';
import {
  PROVIDER,
  MAINNET_CHAINS,
  RELAY_MAX_GAS_COST_WEI,
  relayFreeAuthorization,
} from '@/lib/relay/relayProvider';
import { isKvConfigured } from '@/lib/kv';
import type { RelayResult } from '@/lib/relay/jpycRelay';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 4 * 1024;
const CSV_PASS_RELAY_MAX_MULTIPLE = 10n;

function isDec(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) return first.split(':').slice(0, 4).join(':') + '::/64';
  const p = first.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : 'unknown';
}

// 結果 → HTTP 応答 (決済 relay の respond と同形)。pending は 202 で client に fallback 禁止を伝える。
function respond(result: RelayResult, chainId: number): NextResponse {
  switch (result.kind) {
    case 'success':
      return NextResponse.json({ ok: true, txHash: result.txHash });
    case 'reverted':
      logger.warn('csvpass.relay.reverted', { txHash: result.txHash, chainId });
      return NextResponse.json({ ok: false, reverted: true, txHash: result.txHash });
    case 'pending':
      // broadcast 済だが未確定。client は standard へ fallback してはならない (二重支払い防止)。
      logger.warn('csvpass.relay.pending', { txHash: result.txHash, chainId });
      return NextResponse.json(
        { ok: false, pending: true, txHash: result.txHash ?? null },
        { status: 202 },
      );
    case 'rejected':
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: result.httpStatus },
      );
    case 'relay_error':
      logger.warn('csvpass.relay.relay_error', { detail: result.detail, chainId });
      return NextResponse.json({ ok: false, error: 'relay_error' }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // flag-off は **認証より前** に 404 (subscribe/pro/billing と同型・inert を最優先)。
  if (!env.enableCsvPass) {
    return NextResponse.json(
      { ok: false, error: 'csvpass_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら 503 (未設定の宛先へ 100 JPYC を送らせない・subscribe と同型)。認証より前。
  if (!env.feeReceiverConfigured) {
    logger.error('csvpass.relay.misconfigured', { reason: 'fee_receiver_unset' });
    return NextResponse.json(
      { ok: false, error: 'csvpass_misconfigured' },
      { status: 503 },
    );
  }
  // relay 未構成 (RELAYER_PRIVATE_KEY / GELATO どちらも無し) → 専用コードで 503 (client が
  // ガスあり fallback 導線へ落とせる)。認証より前 (構成不備は認証に依存しない)。
  if (PROVIDER === null) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  // SIWE 束縛: relayer のガスを認証済み wallet のみが消費できるようにする。
  const session = await requireSession();
  if (!session.ok) return session.response;

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const chainId = raw.chainId;

  // mainnet self-host preflight (決済 relay と同一・Codex P1): これが無いと CSV relay 経由で
  // (a) gas-cost ceiling 無しの無制限ガス支出 (b) KV 未設定で idempotency/日次予算が fail-open
  // になり relayer を素通しで焼ける。エラーコードも決済 relay と揃える (503 → client は
  // gaslessUnavailable → ガスあり fallback 導線へ)。
  if (PROVIDER === 'self-host' && MAINNET_CHAINS.has(chainId)) {
    if (RELAY_MAX_GAS_COST_WEI === 0n) {
      logger.error('csvpass.relay.gas_ceiling_required', { chainId });
      return NextResponse.json(
        { ok: false, error: 'gas_ceiling_required' },
        { status: 503 },
      );
    }
    if (!isKvConfigured()) {
      logger.error('csvpass.relay.kv_required', { chainId });
      return NextResponse.json(
        { ok: false, error: 'kv_required' },
        { status: 503 },
      );
    }
  }

  // body 検証。**`to` は受けない** (サーバが env.feeReceiver で構成し悪用を構造的に遮断)。
  if (
    !isAddress(raw.from as string) ||
    !isDec(raw.value) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const from = getAddress(raw.from as string);

  // from 束縛: 署名者 (= auth.from) はサインイン済み wallet 本人に限る。recover の forwarder→feeReceiver
  // 転送 (from=forwarder) をパス購入と誤認しない。SIWE session が真実点。
  if (from.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'from_mismatch' }, { status: 403 });
  }

  const value = BigInt(raw.value);
  // 100 JPYC 以上。少額 overpay は受理するが、汎用 relay 上限 (既定 50,000 JPYC) まで許すと
  // パス購入 endpoint として広すぎるため 10 倍で cap する。額不足も subscribe の minValue を
  // 満たさないため事前に弾く。
  if (value < csvPassPriceWei) {
    return NextResponse.json({ ok: false, error: 'insufficient_value' }, { status: 400 });
  }
  if (value > csvPassPriceWei * CSV_PASS_RELAY_MAX_MULTIPLE) {
    return NextResponse.json({ ok: false, error: 'value_too_large' }, { status: 400 });
  }

  // auth は **サーバ権威** で構成 (to=env.feeReceiver 固定・client の to は受けない)。署名は to を含む
  // ので、別宛先で署名された authorization は recoverTransferAuthorizationSigner!==from で弾かれる。
  const auth = {
    from,
    to: getAddress(env.feeReceiver),
    value,
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    nonce: raw.nonce as Hex,
  };

  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );

  logger.info('csvpass.relay.submit', { chainId, from });

  // 共通 free relay (self-host/Gelato submit・poll・rate-limit・日次予算・idempotency)。idem は
  // csvpassrelay:idem: 専用 prefix。a1 ゲート / 決済ログ / billing メーターは通さない (購入は GMV でない)。
  const result = await relayFreeAuthorization(
    chainId,
    auth,
    raw.signature as Hex,
    [auth.from, ipPrefix],
    { idemPrefix: 'csvpassrelay:idem:' },
  );
  return respond(result, chainId);
}
