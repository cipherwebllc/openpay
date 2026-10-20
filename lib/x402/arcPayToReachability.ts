import 'server-only';

import { createPublicClient, getAddress, isAddress, type Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { arc, arcTestnet, transportForChain } from '@/lib/chains';
import { isNonDelegatedContractCode } from '@/lib/accountCode';
import { x402Config } from './config';

export type ArcPayToReachability =
  | { ok: true; payTo: Address }
  | { ok: false; reason: 'contract_wallet' | 'rpc_unavailable' | 'invalid' };

/** 1 回の RPC の上限と、検査全体の締め切り (Base と Arc は並行・再試行 1 回込み)。 */
export const ARC_PAYTO_RPC_TIMEOUT_MS = 3_000;
export const ARC_PAYTO_RPC_DEADLINE_MS = 6_000;

/**
 * 出品の「Arc (Circle Gateway) でも販売する」の受取先 fence (plans/arc-gateway-payout.md・user 裁定 2026-10-20)。
 *
 * Arc の売上は受取アドレスの Gateway 残高に入り、引き出すには受取アドレスが BurnIntent に署名する。
 * コントラクトウォレット (Safe 等) は通常の署名ができず、Circle の別の手順 (ERC-1271・delegate・7 日の出金) は
 * どれもそのコントラクトが Arc 上にあることが前提 — Base の Safe は Arc に無いのがふつうで、売上が閉じ込められる。
 * 受取先が Base か Arc でコードを持つ (7702 の委任は除く) なら Arc の同意を受け付けない。
 * 網は x402 の network に追従 (base-sepolia → Base Sepolia + Arc testnet・それ以外 → Base + Arc mainnet)。
 */
export async function checkArcPayToReachability(rawPayTo: string): Promise<ArcPayToReachability> {
  if (!isAddress(rawPayTo)) return { ok: false, reason: 'invalid' };
  const payTo = getAddress(rawPayTo);
  const chains = x402Config.network === 'base-sepolia' ? [baseSepolia, arcTestnet] : [base, arc];
  // 登録の route は maxDuration 15 秒。RPC が応答しないときも、その前に 503 (rpc_unavailable) を返せるよう
  // 時間を区切る (viem の既定は 10 秒 × 再試行 3 回で、route ごと打ち切られて決めた 503 を返せない)。
  const transport = { timeout: ARC_PAYTO_RPC_TIMEOUT_MS, retryCount: 1, deadline: Date.now() + ARC_PAYTO_RPC_DEADLINE_MS };
  try {
    const codes = await Promise.all(
      chains.map((chain) =>
        createPublicClient({ chain, transport: transportForChain(chain.id, transport) }).getBytecode({ address: payTo }),
      ),
    );
    return codes.some(isNonDelegatedContractCode) ? { ok: false, reason: 'contract_wallet' } : { ok: true, payTo };
  } catch {
    // RPC 障害を EOA と誤認すると、引き出せない受取先で Arc の売上を受けてしまうため fail-closed。
    // 止まるのは Arc に同意した登録・変更だけ (同意を外せば登録できる)。
    return { ok: false, reason: 'rpc_unavailable' };
  }
}

type UsdcFace = { payTo: string; arc?: boolean } | undefined;

/**
 * 登録 (POST)・変更 (PATCH) の Arc 受取先の検査。返り値が null なら通す。
 * 検査するのは Arc に同意しているときだけ。同意済みで受取先も同じ変更 (説明文だけの編集等) は、RPC 障害で
 * 無関係な編集を止めないために検査しない (受取先か同意が変わるときは必ず検査する)。
 */
export async function arcPayToRejection(
  next: UsdcFace,
  prev?: UsdcFace,
): Promise<{ error: 'usdc_arc_contract_pay_to' | 'usdc_arc_check_unavailable' | 'invalid_usdc_pay_to'; status: 400 | 503 } | null> {
  if (next?.arc !== true) return null;
  if (prev?.arc === true && prev.payTo === next.payTo) return null;
  const checked = await checkArcPayToReachability(next.payTo);
  if (checked.ok) return null;
  if (checked.reason === 'contract_wallet') return { error: 'usdc_arc_contract_pay_to', status: 400 };
  if (checked.reason === 'rpc_unavailable') return { error: 'usdc_arc_check_unavailable', status: 503 };
  return { error: 'invalid_usdc_pay_to', status: 400 };
}
