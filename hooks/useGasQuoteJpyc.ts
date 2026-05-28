'use client';

// JPYC Sponsorship Paymaster の gas 徴収額 (JPYC 建て) を算出するフック。
//
// Pimlico が chain native (POL / KAIA) でガスを立替え、運営は徴収 JPYC で精算する。
// 徴収額 = (gas ceiling 価格) × (overhead gas units) × (native/JPYC rate)。
//
// 案A (collect-at-ceiling): 徴収を live gas price ではなく gas ceiling 価格で行う。
//
// 保証の範囲 (正確に):
//   - PRICE 次元は保証される。assertGasCeiling (useBatchPayment、fast tier) が
//     ceiling 超を reject し、submit は standard tier で支払うので
//     standard ≤ fast ≤ ceiling。徴収の ceiling 価格 ≥ 実支払いの standard 価格。
//   - 加えて native→JPYC rate buffer (POL +37% 等) が実勢との差を吸収する。
//   - ただし GAS UNITS 次元は無条件保証ではない。徴収は固定 overhead (既定 200k)
//     見積で、実 UserOp の gas units がこれを大きく超え (例: multi-recipient split で
//     transfer 本数増) かつ congestion で standard が ceiling 近くまで上がる稀ケースでは
//     徴収 < 実費になり得る。平常時は ceiling/standard 比 (Polygon で ~3.3x) と rate
//     buffer で十分カバーされるが、残存リスクとして運用監視する (DEPLOY_CHECKLIST §9.5)。
//
// 徴収は決済額に連動しない (= 為替/資金移動ではないインフラ実費)。
//
// rate は外部 API 依存を持たず env で運用更新可、設定漏れ時は chain ごと
// hard-code default にフォールバック。

import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { gasCeilingGweiForChain } from '@/lib/gasCeiling';
import {
  isJpycSponsorshipChain,
  resolveNativeJpycRate,
} from '@/lib/gasReimbursement';
import { resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

const GWEI = 10n ** 9n;

// 実測 UserOp gas (Pimlico bundler 平均) は typical ~200k 前後 (ERC20 transfer
// 2 件 + paymaster validate)。worst-case として 200k に圧縮、`NEXT_PUBLIC_GAS_
// QUOTE_OVERHEAD_GAS` で再調整可能。300k だと小額 tip に対して overcollect
// が大きすぎ UX 悪化したため見直し。
const DEFAULT_USEROP_GAS_UNITS = 200_000n;

export function useGasQuoteJpyc(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const isActive = enabled && resolvePaymasterMode(deployment) === 'sponsorship';
  const isJpycChain = isJpycSponsorshipChain(deployment.chainId);
  const rate = resolveNativeJpycRate(deployment.chainId);

  const ceilingGwei = gasCeilingGweiForChain(deployment.chainId);

  return useQuery({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-jpyc',
      deployment.chainId,
      Number(rate),
      Number(ceilingGwei ?? 0n),
    ],
    staleTime: Infinity,
    queryFn: () => {
      // ceiling が定義された JPYC chain (Polygon/Amoy/Kaia/Kairos) のみ徴収。
      // 非対象 chain や ceiling 未定義時は 0 (UI 表示の defensive、JPYC は元々
      // 4 chain にしか deploy されていないため通常は到達しない)。
      if (!isJpycChain || ceilingGwei === undefined) return { gasAmount: 0n };
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      // 案A: live gas price ではなく ceiling 価格で徴収する。assertGasCeiling が
      // ceiling 超を弾くため実 price ≤ ceiling、submit の standard 価格との差が
      // 黒字マージン (price 次元の保護)。gas UNITS 側は overhead 固定見積なので
      // split 等で実 units が超えると congestion 時に不足し得る (header 参照)。
      const gasNative = overhead * ceilingGwei * GWEI;
      const gasAmount = gasNative * rate;
      return { gasAmount };
    },
  });
}
