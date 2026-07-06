// x402 facilitator の **server-only** 設定。lib/x402/config.ts と同じ理由で
// (手数料率/floor/受領証明鍵は client bundle に出さない) NEXT_PUBLIC_ を使わず
// process.env.X402_* を直接読む。client へ露出するのは flag (env.enableX402Facilitator) のみ。
//
// 設計判断 (plans/x402-jpyc-facilitator.md):
//   - 手数料 = max(feeFloorWei, price × feeBps/10000)・**買い手上乗せ**。seller は表示額(price)を
//     そのまま受領し、agent は price+fee を署名する (lib/x402/fee.ts)。
//   - floor 既定 1 JPYC (2026-07-05 ユーザ確定で 2→1 に改定。DISCLOSED_X402_FEE と同時変更)。Eip3009Forwarder.settle は feeValue==0 を
//     ZeroValue で revert するため floor は常に 1 wei 以上を保証する (0/不正は既定 1 へ倒す)。
//   - feeBps 既定 100 (= 1%)。facilitator 自体が flag でゲートされるため、点灯時は意図どおり
//     1% を既定にする (recover の bps 既定 0 = inert とは方針が異なる)。fat-finger 防止に上限 10%。
//   - settlement は既存 forwarder (lib/relay) を再利用するため、ノンカストディ性 / relayer 鍵 /
//     冪等・レート・予算ガードは relay 側と共有 (このモジュールは料率と readiness のみ)。

import { polygon, polygonAmoy } from 'viem/chains';
import { env, isMainnet } from '@/lib/env';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { resolveDeployment } from '@/lib/tokens';

const DEFAULT_FEE_BPS = 100; // 1%
const MAX_FEE_BPS = 1000; // 10% — fat-finger ceiling (recover と同方針)
const DEFAULT_FLOOR_HUMAN = 1n; // 1 JPYC (2026-07-05 ユーザ確定・実測 settle ガス ~0.5 円の 2 倍)
const JPYC_DECIMALS = 18;

function nonEmpty(raw: string | undefined): string | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

// 10 進整数のみ受理し [0, MAX_FEE_BPS] に clamp。'1e3'/'0x10'/'2.5'/空白等は弾いて既定へ倒す。
function parseFeeBps(raw: string | undefined): number {
  const v = nonEmpty(raw);
  if (v === undefined || !/^[0-9]+$/.test(v)) return DEFAULT_FEE_BPS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_FEE_BPS;
  return n > MAX_FEE_BPS ? MAX_FEE_BPS : n;
}

// human JPYC (整数) → atomic (18 decimals)。0 / 非数値 / 未設定は既定 1 JPYC (DEFAULT_FLOOR_HUMAN) へ倒す
// (feeValue==0 = ZeroValue revert を構造的に防ぐ)。
function parseFloorWei(raw: string | undefined): bigint {
  const v = nonEmpty(raw);
  if (v === undefined || !/^[0-9]+$/.test(v)) {
    return DEFAULT_FLOOR_HUMAN * 10n ** BigInt(JPYC_DECIMALS);
  }
  const human = BigInt(v);
  if (human === 0n) return DEFAULT_FLOOR_HUMAN * 10n ** BigInt(JPYC_DECIMALS);
  return human * 10n ** BigInt(JPYC_DECIMALS);
}

// facilitator の対象 chainId (Phase 1 = Polygon のみ)。NETWORK_ENV に従い
// mainnet = Polygon(137) / testnet = Polygon Amoy(80002)。Kaia/Avalanche 拡張時はここを配列化する。
const facilitatorChainId = isMainnet ? polygon.id : polygonAmoy.id;

export const x402FacilitatorConfig = {
  feeBps: parseFeeBps(process.env.X402_FEE_BPS),
  feeFloorWei: parseFloorWei(process.env.X402_FEE_FLOOR_JPYC),
  feeReceiver: env.feeReceiver,
  feeReceiverConfigured: env.feeReceiverConfigured,
  // Phase 1 対応 chainId (= 既定の出力先)。
  chainId: facilitatorChainId,
  supportedChainIds: [facilitatorChainId] as readonly number[],
  jpycDecimals: JPYC_DECIMALS,
} as const;

export type X402FacilitatorReadiness =
  | { ready: true }
  | { ready: false; reason: 'fee_receiver_unconfigured' | 'forwarder_unconfigured' | 'jpyc_unavailable' };

// facilitator が当該 chain で実際に settle できるか (flag は別途 env.enableX402Facilitator)。
// forwarder 未設定 (分割不可) / feeReceiver=burn (手数料消失) / JPYC 未 deploy では機能しない。
// route はこれで 503 を返し、誤設定での silent failure を防ぐ。
export function x402FacilitatorReady(chainId: number): X402FacilitatorReadiness {
  if (!x402FacilitatorConfig.feeReceiverConfigured) {
    return { ready: false, reason: 'fee_receiver_unconfigured' };
  }
  if (configuredJpycForwarderFor(chainId) === null) {
    return { ready: false, reason: 'forwarder_unconfigured' };
  }
  if (resolveDeployment('jpyc', chainId) === undefined) {
    return { ready: false, reason: 'jpyc_unavailable' };
  }
  return { ready: true };
}
