// alpha 取引 log 受信 endpoint。
// graceful degrade: KV 未設定 / KV 障害でも 200 を返す (UI 影響回避)。

import { NextResponse } from 'next/server';
import { isAddress, isHex } from 'viem';
import { kvLpush, kvLtrim } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';
const MAX_BODY_BYTES = 8 * 1024;
// alpha 6 ヶ月 + 余裕。古い entry は LPUSH 後の LTRIM で自動破棄。
const LIST_CAP = 100_000;

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

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

function validAddress(v: unknown): v is AddressLike {
  return typeof v === 'string' && isAddress(v, { strict: false });
}

function validHex(v: unknown): v is HexLike {
  return typeof v === 'string' && isHex(v) && v.length > 2;
}

// 許可 field のみ抽出して返す (許可リスト方式)。raw cast で未知 field が
// 後段の spread 経由で KV に流入するのを防ぐ。
function validate(raw: unknown): Payload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.flow !== 'batch' && r.flow !== 'direct') return null;
  if (r.result !== 'success' && r.result !== 'reverted' && r.result !== 'error') return null;
  if (typeof r.chainId !== 'number' || !Number.isInteger(r.chainId) || r.chainId <= 0) return null;
  if (!validAddress(r.tokenAddress)) return null;
  if (!validAddress(r.merchant)) return null;
  if (!isDecimalString(r.merchantAmount)) return null;
  if (r.customer !== undefined && !validAddress(r.customer)) return null;
  if (r.feeReceiver !== undefined && !validAddress(r.feeReceiver)) return null;
  if (r.feeAmount !== undefined && !isDecimalString(r.feeAmount)) return null;
  if (r.userOpHash !== undefined && !validHex(r.userOpHash)) return null;
  if (r.txHash !== undefined && !validHex(r.txHash)) return null;
  if (r.blockNumber !== undefined && !isDecimalString(r.blockNumber)) return null;
  if (r.errorMessage !== undefined && typeof r.errorMessage !== 'string') return null;

  const clean: Payload = {
    flow: r.flow,
    result: r.result,
    chainId: r.chainId,
    tokenAddress: r.tokenAddress,
    merchant: r.merchant,
    merchantAmount: r.merchantAmount,
  };
  if (r.customer !== undefined) clean.customer = r.customer;
  if (r.feeReceiver !== undefined) clean.feeReceiver = r.feeReceiver;
  if (r.feeAmount !== undefined) clean.feeAmount = r.feeAmount;
  if (r.userOpHash !== undefined) clean.userOpHash = r.userOpHash;
  if (r.txHash !== undefined) clean.txHash = r.txHash;
  if (r.blockNumber !== undefined) clean.blockNumber = r.blockNumber;
  if (r.errorMessage !== undefined) clean.errorMessage = r.errorMessage;
  return clean;
}

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
    // 短期トラブルシュート用に subnet 粒度 (IPv4 /24 / IPv6 /64) で保管。
    ipPrefix: anonymizeIp(
      req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
    ),
    userAgent: (req.headers.get('user-agent') ?? '').slice(0, 200),
    ...payload,
  };
  logger.info('payment.event', entry);

  const kv = await kvLpush(KV_KEY, JSON.stringify(entry));
  if (!kv.ok && kv.reason !== 'unconfigured') {
    logger.warn('payment-log.kv-write-failed', { reason: kv.reason, status: kv.status });
  } else if (kv.ok) {
    // 古い entry を捨てて list size を有界化。失敗しても client には返さない。
    const trim = await kvLtrim(KV_KEY, 0, LIST_CAP - 1);
    if (!trim.ok && trim.reason !== 'unconfigured') {
      logger.warn('payment-log.kv-trim-failed', { reason: trim.reason, status: trim.status });
    }
  }

  return NextResponse.json({ ok: true });
}

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) {
    return first.split(':').slice(0, 4).join(':') + '::/64';
  }
  const parts = first.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return '';
}
