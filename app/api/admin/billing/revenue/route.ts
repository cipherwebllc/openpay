// 運営 (OpenPay 自社) 専用: a1 利用料の収益確認 + freee 用 CSV + 期間照合。
// SIWE で識別した wallet が ADMIN_WALLETS に載っている場合のみ (二段: requireSession → isAdminWallet)。
// GET ?format=freee|csv → 収入の生データ CSV (税理士提出/ freee 取込)。それ以外 → JSON (合計/期間別/入金一覧/照合)。
// 設計: docs/plans/admin-billing-revenue.md。
import { NextResponse } from 'next/server';
import { requireSession } from '../../../auth/siwe/_session';
import { isAdminWallet } from '@/lib/adminAuth';
import {
  getFeeRevenueEvents,
  summarizeRevenue,
  loadReconciliation,
} from '@/lib/feeRevenue';
import { toFeeRevenueCsv } from '@/lib/feeRevenueCsv';
import { previousPeriod } from '@/lib/feeGate';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: Request): Promise<NextResponse> {
  // 連打を session/収益 KV 読取へ波及させない。limiter の KV 障害は既存 helper が fail-open。
  if (!(await checkIpRateLimit('admin-billing-revenue', hashIp(clientIp(req)), 30, 60))) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;
  if (!isAdminWallet(session.address)) {
    // 無料 SIWE session の拒否連打を Sentry quota 消費へ波及させない。
    logger.info('admin.billing.forbidden', { wallet: session.address });
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const events = await getFeeRevenueEvents();
  const format = new URL(req.url).searchParams.get('format');

  // 生データ CSV (収入があった事実 = 税理士へ・freee 取込にも)。
  if (format === 'freee' || format === 'csv') {
    return new NextResponse(toFeeRevenueCsv(events), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="openpay-fee-revenue.csv"',
        'cache-control': 'no-store',
      },
    });
  }

  const summary = summarizeRevenue(events);
  const period = previousPeriod(Date.now());
  const reconciliation = await loadReconciliation(period, events);

  return NextResponse.json({
    ok: true,
    totalWei: summary.totalWei.toString(),
    count: summary.count,
    byBilledPeriod: summary.byBilledPeriod.map((b) => ({
      period: b.period,
      count: b.count,
      feeWei: b.feeWei.toString(),
    })),
    byPaymentMonth: summary.byPaymentMonth.map((b) => ({
      month: b.month,
      count: b.count,
      feeWei: b.feeWei.toString(),
    })),
    reconciliation: {
      period,
      rows: reconciliation.map((r) => ({
        merchant: r.merchant,
        billedFeeWei: r.billedFeeWei.toString(),
        paid: r.paid,
        txHash: r.txHash,
        paidAtMs: r.paidAtMs,
      })),
    },
    payments: events, // 新しい順 (LPUSH 先頭)
  });
}
