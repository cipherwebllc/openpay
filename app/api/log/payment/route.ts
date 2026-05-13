// alpha 取引 log の受信 endpoint。
// クライアント (useBatchPayment / useDirectPayment) が成功・失敗時に POST する。
// 受信した payload に server timestamp を付与し、Upstash Redis (Vercel KV) の
// list に LPUSH する。KV 未設定時は console.log のみで graceful degrade。
//
// 想定 retention: alpha 6 ヶ月運用後に弁護士・demand signal 集計に export する。
// Export endpoint は /api/log/payment/export (Bearer 認証)。

import { NextResponse } from 'next/server';
import { kvLpush } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';

type AddressLike = `0x${string}`;
type HexLike = `0x${string}`;

type Payload = {
  flow: 'batch' | 'direct';
  result: 'success' | 'reverted' | 'error';
  chainId: number;
  tokenAddress: AddressLike;
  merchant: AddressLike;
  merchantAmount: string;
  customer?: AddressLike;
  feeReceiver?: AddressLike;
  feeAmount?: string;
  userOpHash?: HexLike;
  txHash?: HexLike;
  blockNumber?: string;
  errorMessage?: string;
};

function isAddress(v: unknown): v is AddressLike {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isHex(v: unknown): v is HexLike {
  return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);
}
function isDecimalString(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

function validate(raw: unknown): Payload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.flow !== 'batch' && r.flow !== 'direct') return null;
  if (r.result !== 'success' && r.result !== 'reverted' && r.result !== 'error') return null;
  if (typeof r.chainId !== 'number' || !Number.isInteger(r.chainId) || r.chainId <= 0) return null;
  if (!isAddress(r.tokenAddress)) return null;
  if (!isAddress(r.merchant)) return null;
  if (!isDecimalString(r.merchantAmount)) return null;
  if (r.customer !== undefined && !isAddress(r.customer)) return null;
  if (r.feeReceiver !== undefined && !isAddress(r.feeReceiver)) return null;
  if (r.feeAmount !== undefined && !isDecimalString(r.feeAmount)) return null;
  if (r.userOpHash !== undefined && !isHex(r.userOpHash)) return null;
  if (r.txHash !== undefined && !isHex(r.txHash)) return null;
  if (r.blockNumber !== undefined && !isDecimalString(r.blockNumber)) return null;
  if (r.errorMessage !== undefined && typeof r.errorMessage !== 'string') return null;
  return raw as Payload;
}

const MAX_BODY_BYTES = 8 * 1024; // 8 KB; payload は 1 KB 程度の想定

export async function POST(req: Request): Promise<NextResponse> {
  const lenHeader = req.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const payload = validate(raw);
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const entry = {
    serverTs: new Date().toISOString(),
    // privacy: IP は Vercel が forwarder に詰める。短期トラブルシュートには有用
    // だが、長期 retention は不要。短縮 (subnet) してから保存する。
    ipPrefix: anonymizeIp(
      req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
    ),
    userAgent: (req.headers.get('user-agent') ?? '').slice(0, 200),
    ...payload,
  };
  const serialized = JSON.stringify(entry);

  // Vercel runtime log への記録 (KV 未設定時も解析可能にする)
  logger.info('payment.event', entry);

  const kv = await kvLpush(KV_KEY, serialized);
  if (!kv.ok && kv.reason !== 'unconfigured') {
    logger.warn('payment-log.kv-write-failed', { reason: kv.reason, status: kv.status });
  }

  // 失敗を返すと client が retry / UI 影響する可能性があるため、KV 障害でも 200
  return NextResponse.json({ ok: true });
}

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) {
    // IPv6: 上位 4 hextet のみ
    return first.split(':').slice(0, 4).join(':') + '::/64';
  }
  // IPv4: /24 サブネット
  const parts = first.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return '';
}
