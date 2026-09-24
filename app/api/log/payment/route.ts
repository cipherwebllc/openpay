// alpha 取引 log 受信 endpoint。
// graceful degrade: KV 未設定 / KV 障害でも 200 を返す (UI 影響回避)。

import { after, NextResponse } from 'next/server';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { kvIncr, kvLpush, kvSet } from '@/lib/kv';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import {
  PAYMENT_LOG_KV_KEY,
  type ClientReportedCircleVerification,
} from '@/lib/paymentLog';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
// P3: anonymizeIp を単一情報源化 (旧 local 実装は fallback が '' で relayRoute の 'unknown' と乖離し、
// 不正形式 IP が同一空文字バケツを共有する rate-limit 相乗りの恐れがあった)。
import { anonymizeIp, isDecWithin, MAX_UINT256_DEC_DIGITS } from '@/lib/relay/relayRoute';

export const runtime = 'nodejs';

// buildPaymentLogEvent の全 optional field (7×78 桁の金額・5×42 字 address・4×66 字 hash
// + chain ID / key / enum 等) は errorMessage が空なら最大 1,600 B。
// 500 UTF-16 単位の message は CJK で 500×3 B、quote/newline で 500×2 B、
// JSON の制御文字 / lone surrogate escape が最大 500×6 B。
// 1,600 + 3,000 = 4,600 B < 5 KiB とし、正規のエラーログを body cap で失わない。
const MAX_BODY_BYTES = 5 * 1024;
// 未認証 telemetry による共有 KV 枯渇が SIWE / relay / settle の書込へ波及するのを断つ。
// 既存 list も次回の保存時に最新 20k 件へ trim。TTL は保存のたびに延長する (entry 単位ではない)。
const LIST_CAP = 20_000;
const LIST_TTL_SEC = 35 * 24 * 60 * 60;
const DAILY_WRITE_BUDGET = 5_000;
// UTC 日付ごとに key が変わる。窓の途中で counter が消えて予算を再利用されないよう 2 日保持。
const BUDGET_TTL_SEC = 2 * 24 * 60 * 60;
// errorMessage は client 申告の自由文字列。body 上限 (5KB) 内でも 1 entry が肥大化して
// 共有リストの容量を食い潰すため、保存前に切詰める (reject はしない — ログは best-effort)。
const ERROR_MESSAGE_MAX = 500;

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
  tip?: true;
  chainSlug?: import('@/lib/chains').ChainSlug;
  mode?: 'standard';
  flow: 'batch' | 'direct' | 'standard-merchant' | 'standard-fee';
  result: 'success' | 'reverted' | 'error';
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: string;
  customer?: Address;
  feeReceiver?: Address;
  feeAmount?: string;
  // 売上総額 (gross・raw) と全経路横断のネットワーク手数料相当額 (raw)、内訳版 (v3)。
  saleAmount?: string;
  networkFeeEquivalent?: string;
  feeBreakdownVersion?: number;
  userOpHash?: Hex;
  txHash?: Hex;
  feeTxHash?: Hex;
  blockNumber?: string;
  errorMessage?: string;
  // cross-chain bridge 経由の決済を区別する optional fields (phase 2)。
  // direct (同一 chain) では undefined、Gateway/CCTP V2 経由なら値が入る。
  bridge?: 'gateway' | 'cctp-v2';
  sourceChainId?: number;
  // cross-chain 会計フィールド (unreconciled・reported)。bridgedAmount / bridgeFeeMax は raw
  // decimal、burnTxHash は CCTP source burn tx。
  bridgedAmount?: string;
  bridgeFeeMax?: string;
  burnTxHash?: Hex;
  gatewayTransferSpecHash?: Hex;
  // Circle Paymaster 監査 (gasless circle 経路のみ・Phase1 C2/C3)。
  provider?: 'pimlico' | 'circle';
  circlePaymasterAddress?: Address;
  circlePaymasterNetUsdc?: string;
  // client 経路では 'verified' は受理しない (server verifier 専用)。型は paymentLog の
  // CircleVerificationStatus から 'verified' を除いた導出型で、status 追加時に追従する。
  circleVerification?: ClientReportedCircleVerification;
};

function isDecimalString(v: unknown): v is string {
  return isDecWithin(v, MAX_UINT256_DEC_DIGITS);
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
  if (r.saleAmount !== undefined && !isDecimalString(r.saleAmount)) return null;
  if (
    r.networkFeeEquivalent !== undefined &&
    !isDecimalString(r.networkFeeEquivalent)
  )
    return null;
  if (
    r.feeBreakdownVersion !== undefined &&
    (typeof r.feeBreakdownVersion !== 'number' ||
      !Number.isInteger(r.feeBreakdownVersion) ||
      r.feeBreakdownVersion < 0)
  )
    return null;
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
  if (r.bridgedAmount !== undefined && !isDecimalString(r.bridgedAmount))
    return null;
  if (r.bridgeFeeMax !== undefined && !isDecimalString(r.bridgeFeeMax))
    return null;
  if (r.gatewayTransferSpecHash !== undefined && (r.bridge !== 'gateway' || !validHex(r.gatewayTransferSpecHash))) return null;
  if (r.burnTxHash !== undefined && !validHex(r.burnTxHash)) return null;
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
  // ⚠️ 'verified' は **server/offline verifier が on-chain receipt で再計算した時のみ**
  // 付与してよい値。本 endpoint は未認証で client 申告なので 'verified' を **拒否**する
  // (client が verified Circle gas 総額を偽装し stats の verified bucket を汚染するのを防ぐ)。
  // client が報告できるのは 'client-reported' / 'unreconciled' のみ。
  if (
    r.circleVerification !== undefined &&
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
  if (r.tip === true && r.chainSlug === 'arc' && r.mode === 'standard') {
    clean.tip = true;
    clean.chainSlug = 'arc';
    clean.mode = 'standard';
  }
  if (r.customer !== undefined) clean.customer = r.customer;
  if (r.feeReceiver !== undefined) clean.feeReceiver = r.feeReceiver;
  if (r.feeAmount !== undefined) clean.feeAmount = r.feeAmount;
  if (r.saleAmount !== undefined) clean.saleAmount = r.saleAmount;
  if (r.networkFeeEquivalent !== undefined)
    clean.networkFeeEquivalent = r.networkFeeEquivalent;
  if (r.feeBreakdownVersion !== undefined)
    clean.feeBreakdownVersion = r.feeBreakdownVersion;
  if (r.userOpHash !== undefined) clean.userOpHash = r.userOpHash;
  if (r.txHash !== undefined) clean.txHash = r.txHash;
  if (r.feeTxHash !== undefined) clean.feeTxHash = r.feeTxHash;
  if (r.blockNumber !== undefined) clean.blockNumber = r.blockNumber;
  // 自由文字列は保存前に切詰める (拒否はしない — ログ欠落より短縮を選ぶ)。
  if (r.errorMessage !== undefined)
    clean.errorMessage = r.errorMessage.slice(0, ERROR_MESSAGE_MAX);
  if (r.bridge !== undefined) clean.bridge = r.bridge;
  if (r.sourceChainId !== undefined) clean.sourceChainId = r.sourceChainId;
  if (r.bridgedAmount !== undefined) clean.bridgedAmount = r.bridgedAmount;
  if (r.bridgeFeeMax !== undefined) clean.bridgeFeeMax = r.bridgeFeeMax;
  if (r.burnTxHash !== undefined) clean.burnTxHash = r.burnTxHash;
  if (r.gatewayTransferSpecHash !== undefined) clean.gatewayTransferSpecHash = r.gatewayTransferSpecHash;
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
  // content-length header での早期 reject (best-effort)。header は偽装/欠落しうるので
  // これだけに頼らない。
  const lenHeader = req.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  // header 欠落/詐称でも累積 byte cap で読み取りを止め、巨大 body のメモリ消費の波及を断つ。
  const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  if (!body.ok) {
    const tooLarge = body.reason === 'too_large';
    return NextResponse.json(
      { ok: false, error: tooLarge ? 'payload_too_large' : 'invalid_json' },
      { status: tooLarge ? 413 : 400 },
    );
  }
  const payload = validate(body.value);
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const ipPrefix = anonymizeIp(
    clientIp(req) ?? '',
  );
  // IPv6 の host 部の変更による制限回避が log の共有 KV 枠へ波及するのを /64 bucket で断つ。
  // IPv4 NAT と同様、同じ /64 の正規ユーザも 60 回/分の枠を共有するトレードオフを受け入れる。
  // HMAC 無効時も telemetry を止めず、従来の匿名化 prefix による制限を保つ。
  const limiterKey = hashIpBucket(clientIp(req)) ?? ipPrefix;
  try {
    if (!(await checkReadRateLimit(`logpay:${limiterKey}`, 60, 60))) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // Telemetry is best-effort; KV/rate-limit errors must not break payment logging.
  }

  const entry = {
    serverTs: new Date().toISOString(),
    // ipPrefix は limiter 専用。reader が無い利用者 subnet を list / logger に保存しない。
    userAgent: (req.headers.get('user-agent') ?? '').slice(0, 200),
    ...payload,
  };
  logger.info('payment.event', entry);

  // IP を分散した telemetry flood の容量消費が SIWE / relay / settle 台帳へ波及するのを断つ。
  // 予算超過は保存だけ省略し、成功応答を維持。KV 障害も決済へ波及させず fail-open。
  // 予算・保存の I/O は after() に閉じ、決済側の応答を遅くしない (掟 12/13)。
  after(async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const budget = await kvIncr(`logpay:budget:${day}`, { initialTtlSec: BUDGET_TTL_SEC });
    if (budget.ok && budget.value > DAILY_WRITE_BUDGET) {
      // log 欠落を観測可能にしつつ、flood が Sentry の警告枠枯渇へ波及するのを断つ。
      // UTC 日付 + SET NX で instance 間でも 1 日 1 回。marker 障害時は警告を省略し、
      // 次の超過 request で再試行する (決済応答や log 保存の skip 判定には波及させない)。
      const warning = await kvSet(`logpay:budget-warn:${day}`, '1', {
        nx: true,
        ttlSec: BUDGET_TTL_SEC,
      });
      if (warning.ok && warning.value === 'OK') {
        logger.warn('payment-log.daily-budget-exhausted', { day });
      }
      return;
    }

    // push / trim / expiry refresh を原子的に行い、部分成功による容量・無期限保持の波及を断つ。
    // unread の日次リストには複製しない。export / stats はこの legacy key を読む。
    const kv = await kvLpush(PAYMENT_LOG_KV_KEY, JSON.stringify(entry), {
      trimStart: 0,
      trimStop: LIST_CAP - 1,
      ttlSec: LIST_TTL_SEC,
    });
    if (!kv.ok && kv.reason !== 'unconfigured') {
      logger.warn('payment-log.kv-write-failed', { reason: kv.reason, status: kv.status });
    }
  });

  return NextResponse.json({ ok: true });
}
