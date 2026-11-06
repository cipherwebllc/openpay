import { describe, expect, it } from 'vitest';
import { FEE_BPS_STANDARD } from '@/lib/fee';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';

// ガード (第 9 回レビュー A-1): executeCctpTransfer の recoveryOnly の停止は、merchant が proceed / adopt
// でも利用料の leg だけが burn だと全体を止め、merchant の mint まで巻き添えにする。利用料が 0 の間は
// 利用料の leg が無いので起きない。このテストが落ちたら (= cross-chain の利用料を 0 より大きくしたら)、
// 先に lib/crossChain/executeCctp.ts の recoveryOnly の停止を「利用料の leg だけ止め、merchant の mint は
// 進める」形に直し、そのテストを足してから、このガードを外すこと。
describe('recoveryOnly fee-leg guard', () => {
  it('keeps the cross-chain fee at zero until the recoveryOnly stop spares the merchant mint', () => {
    // cross-chain の利用料は useCrossChainPayment が 'standard' で計算する。
    expect(FEE_BPS_STANDARD).toBe(0n);
    for (const amount of [1n, 1_000_000n, 1_000_000_000_000n]) {
      expect(computeCrossChainFeeSplit(amount, 'usdc', 'standard').feeAmount).toBe(0n);
    }
  });
});
