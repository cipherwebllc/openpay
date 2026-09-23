// OpenPay Pro (月額固定 ¥500=500 JPYC の前払いサブスク) の加入 API (SIWE 必須・POST)。
// 店主が 500 JPYC を FEE_RECEIVER へ送金 → その txHash を提出する。サーバが (1) on-chain で
// 「セッション wallet → 受領アドレス・JPYC・500 JPYC 一致」を照合し、(2) 支払い tx の block
// timestamp + 30日 を Pro 期限として **決定論的** に付与する。二重付与は txHash idempotency
// (KV nx・短ロック→結果昇格) で防止し、別 wallet による同 txHash 再提出は拒否する。
// Pro flag OFF では 404 (認証/KV より前)。設計: plans/pro-plan.md。
//
// from 束縛が肝: from=session に固定するので、recover の forwarder→feeReceiver 転送
// (from=forwarder) を Pro 支払いと**絶対に誤認しない**。
// core ロジック (ロック→検証→付与→昇格→収益) は lib/entitlementPayment に共有 (CSV パスと共通)。
// 本 route は flag/feeReceiver ゲート + 入力検証 + tier config の注入だけを行う thin wrapper。
import { NextResponse } from 'next/server';
import { isHex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { grantPro, proPriceWei, PRO_GRANT_MS } from '@/lib/proPlan';
import { recordProRevenue } from '@/lib/proRevenue';
import { processEntitlementPayment } from '@/lib/entitlementPayment';
import { logger } from '@/lib/logger';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const SUBSCRIBE_BODY_MAX_BYTES = 4096;

export async function POST(req: Request): Promise<NextResponse> {
  const requestedAtMs = Date.now();
  // flag-off は認証/KV より前に 404 (billing/invoice と同型・inert を最優先)。
  if (!env.enablePro) {
    return NextResponse.json(
      { ok: false, error: 'pro_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら 503 (未設定の宛先へ 500 JPYC を送らせない・settle と同型)。
  if (!env.feeReceiverConfigured) {
    logger.error('pro.subscribe.misconfigured', {
      reason: 'fee_receiver_unset',
    });
    return NextResponse.json(
      { ok: false, error: 'pro_misconfigured' },
      { status: 503 },
    );
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  // 巨大な認証済み body によるメモリ消費が決済 route に波及するのを累積 byte 上限で断つ。
  const capped = await readJsonBodyCapped(req, SUBSCRIBE_BODY_MAX_BYTES);
  if (!capped.ok) {
    if (capped.reason === 'too_large') {
      return NextResponse.json(
        { ok: false, error: 'payload_too_large' },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  // null の分解代入例外が 500 に波及するのを入力境界で断つ。他の項目検証順は維持する。
  if (capped.value === null) {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const body = capped.value as { txHash?: unknown; chainId?: unknown };
  const { txHash, chainId } = body;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_chain' },
      { status: 400 },
    );
  }
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return NextResponse.json(
      { ok: false, error: 'invalid_txhash' },
      { status: 400 },
    );
  }

  return processEntitlementPayment({
    txHash,
    chainId,
    requestedAtMs,
    session: { address: session.address },
    config: {
      enabled: env.enablePro,
      feeReceiverConfigured: env.feeReceiverConfigured,
      usedKeyPrefix: 'pro:used:',
      tier: 'pro',
      priceWei: proPriceWei, // 500 JPYC 一致
      grantMs: PRO_GRANT_MS, // block timestamp + 30日
      grant: (wallet, target) => grantPro(wallet, target),
      recordRevenue: recordProRevenue,
      logPrefix: 'pro.subscribe',
    },
  });
}
