// alpha 取引 log 受信 endpoint。
// graceful degrade: KV 未設定 / KV 障害でも 200 を返す (UI 影響回避)。

import { NextResponse } from 'next/server';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { kvLpush, kvLtrim } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';
const MAX_BODY_BYTES = 8 * 1024;
// alpha 6 ヶ月 + 余裕。古い entry は LPUSH 後の LTRIM で自動破棄。
const LIST_CAP = 100_000;

// flow 一覧:
//   batch:             gasless 経路 (UserOp で merchant + fee を 1 batch 送信、
//                      feeAmount は同 entry 内に含まれる)
//   direct:            同一チェーン直接送金 (cross-chain mint 成功ログ等で生成)
//   standard-merchant: 通常決済（ガスあり）の merchant への送金 tx (EOA writeContract)
//                      feeAmount は無い (fee は別 tx = standard-fee として独立)
//   standard-fee:      通常決済（ガスあり）の OpenPay 利用手数料徴収 tx (EOA writeContract)
//                      merchantAmount に手数料金額が入る (送金先 = feeReceiver)
//                      → stats route 側で「fee tx として totalFeeWei にだけ計上、
//                      GMV / count には含めない」特別扱いをする
type Payload = {
  flow: 'batch' | 'direct' | 'standard-merchant' | 'standard-fee';
  result: 'success' | 'reverted' | 'error';
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: string;
  customer?: Address;
  feeReceiver?: Address;
  feeAmount?: string;
  userOpHash?: Hex;
  txHash?: Hex;
  feeTxHash?: Hex;
  blockNumber?: string;
  errorMessage?: string;
  // cross-chain bridge 経由の決済を区別する optional fields (phase 2)。
  // direct (同一 chain) では undefined、Gateway/CCTP V2 経由なら値が入る。
  bridge?: 'gateway' | 'cctp-v2';
  sourceChainId?: number;
  // Circle Paymaster 監査 (gasless circle 経路のみ・Phase1 C2/C3)。
  provider?: 'pimlico' | 'circle';
  circlePaymasterAddress?: Address;
  circlePaymasterNetUsdc?: string;
  circleVerification?: 'verified' | 'client-reported' | 'unreconciled';
};

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

function validAddress(v: unknown): v is Address {
  return typeof v === 'string' && isAddress(v, { strict: false });
}

function validHex(v: unknown): v is Hex {
  return typeof v === 'string' && isHex(v) && v.length > 2;
}

// 許可 field のみ抽出して返す (許可リスト方式)。raw cast で未知 field が
// 後段の spread 経由で KV に流入するのを防ぐ。
function validate(raw: unknown): Payload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    r.flow !== 'batch' &&
    r.flow !== 'direct' &&
    r.flow !== 'standard-merchant' &&
    r.flow !== 'standard-fee'
  )
    return null;
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
  if (r.feeTxHash !== undefined && !validHex(r.feeTxHash)) return null;
  if (r.blockNumber !== undefined && !isDecimalString(r.blockNumber)) return null;
  if (r.errorMessage !== undefined && typeof r.errorMessage !== 'string') return null;
  if (
    r.bridge !== undefined &&
    r.bridge !== 'gateway' &&
    r.bridge !== 'cctp-v2'
  )
    return null;
  if (
    r.sourceChainId !== undefined &&
    (typeof r.sourceChainId !== 'number' ||
      !Number.isInteger(r.sourceChainId) ||
      r.sourceChainId <= 0)
  )
    return null;
  if (r.provider !== undefined && r.provider !== 'pimlico' && r.provider !== 'circle')
    return null;
  if (
    r.circlePaymasterAddress !== undefined &&
    !validAddress(r.circlePaymasterAddress)
  )
    return null;
  if (
    r.circlePaymasterNetUsdc !== undefined &&
    !isDecimalString(r.circlePaymasterNetUsdc)
  )
    return null;
  if (
    r.circleVerification !== undefined &&
    r.circleVerification !== 'verified' &&
    r.circleVerification !== 'client-reported' &&
    r.circleVerification !== 'unreconciled'
  )
    return null;

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
  if (r.feeTxHash !== undefined) clean.feeTxHash = r.feeTxHash;
  if (r.blockNumber !== undefined) clean.blockNumber = r.blockNumber;
  if (r.errorMessage !== undefined) clean.errorMessage = r.errorMessage;
  if (r.bridge !== undefined) clean.bridge = r.bridge;
  if (r.sourceChainId !== undefined) clean.sourceChainId = r.sourceChainId;
  if (r.provider !== undefined) clean.provider = r.provider;
  if (r.circlePaymasterAddress !== undefined)
    clean.circlePaymasterAddress = r.circlePaymasterAddress;
  if (r.circlePaymasterNetUsdc !== undefined)
    clean.circlePaymasterNetUsdc = r.circlePaymasterNetUsdc;
  if (r.circleVerification !== undefined)
    clean.circleVerification = r.circleVerification;
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
    // LPUSH 成功時点で env は確定設定なので unconfigured 分岐は到達不能。
    const trim = await kvLtrim(KV_KEY, 0, LIST_CAP - 1);
    if (!trim.ok) {
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
