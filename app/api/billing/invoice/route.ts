// OpenPay 利用料 (a1) のインボイス参照 (SIWE 必須・GET)。店主 UI が「請求額・支払い状況」を読む。
// サーバ権威メーター (S1) × 料率 (S2) から、(1) due=前月 (清算対象の閉じた期) と (2) current=当月
// これまで (informational) の {件数, 出来高, 料率, 請求額} を算出し、fee-current 状況 (S3) を返す。
// billing OFF では 404。設計: docs/plans/merchant-gasless-fee-a1.md (S6)。
import { NextResponse } from 'next/server';
import type { Address } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { loadUsageInvoice, meterPeriod } from '@/lib/billingMeter';
import { getFeeStatus, getUnpaidPeriods } from '@/lib/feeCurrent';
import {
  previousPeriod,
  isGaslessRelayBlocked,
  graceEndsAt,
  owedCandidatePeriods,
} from '@/lib/feeGate';
import { usageFeeConfig } from '@/lib/usageFee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type InvoiceJson = {
  period: string;
  count: number;
  volumeWei: string;
  rateBps: number;
  feeWei: string;
  free: boolean;
};

async function invoiceFor(
  period: string,
  merchant: Address,
): Promise<InvoiceJson> {
  const inv = await loadUsageInvoice(period, merchant);
  return {
    period: inv.period,
    count: inv.count,
    volumeWei: inv.volumeWei.toString(),
    rateBps: inv.rateBps,
    feeWei: inv.feeWei.toString(),
    free: inv.free,
  };
}

export async function GET(): Promise<NextResponse> {
  if (!env.enableUsageFee) {
    return NextResponse.json(
      { ok: false, error: 'billing_disabled' },
      { status: 404 },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  const nowMs = Date.now();
  const fee = await getFeeStatus(session.address, nowMs);
  const due = await invoiceFor(previousPeriod(nowMs), session.address);
  const current = await invoiceFor(meterPeriod(nowMs), session.address);
  // 延滞 (lookback 内に未払い請求あり + 月初猶予超過) か。relay 関所ゲートと同一の権威判定を再利用する
  // (isFeePayment=false)。店主 UI が「ガスレス停止 + 履歴/CSV 制限」を出すかの単一ソース。
  // a1 OFF / bypass / fee-current のときは false。
  const delinquent = await isGaslessRelayBlocked(session.address, false, nowMs);

  // 未払いの請求期間一覧 (lookback 内・新しい順)。古い未収を期間別に清算させる UI 用。
  // ゲートと同じ合成: 「請求あり (feeWei>0)」かつ「支払い済みマーカー無し」かつ lastPaidPeriod でない。
  const candidates = owedCandidatePeriods(nowMs, usageFeeConfig().startPeriod);
  const candidateInvoices = await Promise.all(
    candidates.map((p) => invoiceFor(p, session.address)),
  );
  const billedPeriods = candidateInvoices
    .filter((inv) => inv.feeWei !== '0')
    .map((inv) => inv.period);
  const unpaidSet = new Set(await getUnpaidPeriods(session.address, billedPeriods));
  const owed = candidateInvoices.filter(
    (inv) =>
      inv.feeWei !== '0' &&
      unpaidSet.has(inv.period) &&
      inv.period !== fee.lastPaidPeriod,
  );

  return NextResponse.json({
    ok: true,
    feeCurrent: fee.current,
    expiresAt: fee.expiresAt,
    lastPaidPeriod: fee.lastPaidPeriod,
    bypass: fee.bypass,
    delinquent,
    graceEndsAt: graceEndsAt(nowMs), // 当月の遮断開始時刻 (予告バナーの「○○以降停止」用)
    due,
    current,
    owed, // 未払いの請求期間一覧 (新しい順・期間別清算 UI 用)
  });
}
