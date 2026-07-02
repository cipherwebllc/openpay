// CSV 24時間パス (都度 100 JPYC の前払い) の購入 API (SIWE 必須・POST)。店主が 100 JPYC を
// FEE_RECEIVER へ送金 → その txHash を提出する。サーバが (1) on-chain で「セッション wallet →
// 受領アドレス・JPYC・100 JPYC 以上」を照合し、(2) 支払い tx の block timestamp + 24時間 を
// パス期限として **決定論的** に付与する。二重付与は txHash idempotency (KV nx・短ロック→結果昇格)
// で防止し、別 wallet による同 txHash 再提出は拒否する。flag OFF では 404 (認証/KV より前)。
// 設計: plans/csv-pass.md。
//
// from 束縛が肝: from=session に固定するので、recover の forwarder→feeReceiver 転送
// (from=forwarder) をパス購入と**絶対に誤認しない**。
// core ロジック (ロック→検証→付与→昇格→収益) は lib/entitlementPayment に共有 (Pro と共通)。
import { NextResponse } from 'next/server';
import { isHex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { grantCsvPass, csvPassPriceWei, CSV_PASS_GRANT_MS } from '@/lib/csvPass';
import { recordCsvPassRevenue } from '@/lib/csvPassRevenue';
import { processEntitlementPayment } from '@/lib/entitlementPayment';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(req: Request): Promise<NextResponse> {
  // flag-off は認証/KV より前に 404 (pro/billing と同型・inert を最優先)。
  if (!env.enableCsvPass) {
    return NextResponse.json(
      { ok: false, error: 'csvpass_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら 503 (未設定の宛先へ 100 JPYC を送らせない・settle と同型)。
  if (!env.feeReceiverConfigured) {
    logger.error('csvpass.subscribe.misconfigured', {
      reason: 'fee_receiver_unset',
    });
    return NextResponse.json(
      { ok: false, error: 'csvpass_misconfigured' },
      { status: 503 },
    );
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: { txHash?: unknown; chainId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

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
    session: { address: session.address },
    config: {
      enabled: env.enableCsvPass,
      feeReceiverConfigured: env.feeReceiverConfigured,
      usedKeyPrefix: 'csvpass:used:',
      tier: 'csvpass',
      priceWei: csvPassPriceWei, // 100 JPYC 以上 (超過は受理するが付与は 24時間 1 期間のみ)
      grantMs: CSV_PASS_GRANT_MS, // block timestamp + 24時間
      grant: (wallet, target) => grantCsvPass(wallet, target),
      recordRevenue: recordCsvPassRevenue,
      logPrefix: 'csvpass.subscribe',
    },
  });
}
