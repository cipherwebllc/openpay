// B1 Layer B — JPYC ガスレス relayer の **事前 (preflight) 健全性プローブ**。
//
// /pay・/checkout の client が署名 *前* に叩き、relayer が枯渇/未構成なら「通常決済へ切替」を
// 先回りで案内するための advisory エンドポイント。Layer A (RelayFallbackBanner on relay.error) は
// submit が失敗した *後* の reactive な導線。本エンドポイントはその手前で degraded を知らせるだけで、
// 決済の実行経路 (POST /api/relay/jpyc) には一切触れない (advisory only)。
//
// プライバシ/濫用対策: 露出は **粗い** { degraded, reason } のみ (正確な残高/relayer アドレスは返さない)。
// 結果は module-level Map に ~60s キャッシュし、client の定期 poll が RPC を叩き続けないようにする。
//
// fail-OPEN 方針: RPC read が throw したら degraded:false を返す (健全扱い)。健全性プローブの一過性 RPC
// blip で利用者をガスレスから不必要に遠ざけないため。実際の relayer 失敗は submit 時に Layer A が掴む。
//
// relayer の解決 (RELAYER_PRIVATE_KEY → self-host・viem client・残高 read) は決済 route と同じ
// lib/relay/relayProvider を再利用する (鍵/アドレス/client を重複定義しない)。

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  PROVIDER,
  SUPPORTED_CHAINS,
  MAINNET_CHAINS,
  selfHostIoFor,
} from '@/lib/relay/relayProvider';

export const runtime = 'nodejs';
// RPC 残高 read が 1 回入るため、関数のタイムアウトを明示的に短く設ける。
export const maxDuration = 10;

// 粗い健全性判定 (正確な残高/アドレスは決して返さない)。
type HealthResult =
  | { degraded: false }
  | {
      degraded: true;
      // 'unsupported' = 非対応 chain / 'no_relayer' = relayer 鍵未設定 (= self-host でない) /
      // 'low_balance' = relayer の native 残高が保守的フロア未満。
      reason: 'unsupported' | 'no_relayer' | 'low_balance';
    };

// chain 別の保守的な native 残高フロア (wei)。これ未満なら degraded:low_balance を返す。
// scripts/check-pimlico-balance.mjs の本番運用フロア (POL/KAIA ~5・ETH ~0.01) と揃える
// (あちらは Pimlico paymaster deposit・こちらは self-host relayer EOA だが、native ガスの
// 補充 cadence の目安として同じ保守値を使う)。env で override 可 (運用者が cadence に合わせ調整)。
// 既定: Polygon/Kaia は 5 native (5e18)、それ以外 (testnet 含む) は 0.01 native (1e16)。
const FIVE_NATIVE_WEI = 5n * 10n ** 18n;
const HUNDREDTH_NATIVE_WEI = 10n ** 16n;
function lowBalanceFloorWei(chainId: number): bigint {
  const override = process.env.RELAY_HEALTH_MIN_BALANCE_WEI;
  if (override && /^[0-9]+$/.test(override)) return BigInt(override);
  return MAINNET_CHAINS.has(chainId) ? FIVE_NATIVE_WEI : HUNDREDTH_NATIVE_WEI;
}

// 健全性結果の per-chain キャッシュ (process lifetime・~60s TTL)。advisory なので KV は不要。
// client の refetchInterval (60s) と合わせ、複数 client の poll が RPC を叩き続けるのを防ぐ。
const HEALTH_TTL_MS = 60_000;
const healthCache = new Map<number, { value: HealthResult; expiresAt: number }>();

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const chainIdRaw = url.searchParams.get('chainId');
  const chainId = chainIdRaw !== null ? Number(chainIdRaw) : NaN;

  // 非対応 chain (or 数値でない) は粗い unsupported を返す。決済 route と同じく SUPPORTED_CHAINS で判定。
  if (!Number.isInteger(chainId) || !(chainId in SUPPORTED_CHAINS)) {
    return NextResponse.json(
      { degraded: true, reason: 'unsupported' } satisfies HealthResult,
      { status: 200 },
    );
  }

  const cached = healthCache.get(chainId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.value, { status: 200 });
  }

  const result = await probe(chainId);
  healthCache.set(chainId, { value: result, expiresAt: Date.now() + HEALTH_TTL_MS });
  return NextResponse.json(result, { status: 200 });
}

async function probe(chainId: number): Promise<HealthResult> {
  // 決済 route と同じ provider 解決 (RELAYER_PRIVATE_KEY あり → self-host)。self-host でなければ
  // 自前 relayer EOA が無く gasless relay が成立しないため degraded:no_relayer。
  if (PROVIDER !== 'self-host') {
    return { degraded: true, reason: 'no_relayer' };
  }

  // relayer EOA の native 残高を read。selfHostIoFor が決済 route と同一の viem client + relayer
  // account を組むので、鍵/アドレス/transport を重複させない (.getBalance は relayer EOA を読む)。
  try {
    const balance = await selfHostIoFor(chainId).getBalance();
    if (balance < lowBalanceFloorWei(chainId)) {
      return { degraded: true, reason: 'low_balance' };
    }
    return { degraded: false };
  } catch (e) {
    // fail-OPEN: 健全性プローブの一過性 RPC エラーで利用者をガスレスから遠ざけない (degraded:false)。
    // 実際の relayer 失敗は submit 時に Layer A (RelayFallbackBanner on relay.error) が掴む。
    logger.warn('relay.jpyc.health.probe_failed', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { degraded: false };
  }
}
