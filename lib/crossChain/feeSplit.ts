// 案A: cross-chain (Circle Gateway / CCTP V2) 決済で OpenPay 利用料を source
// チェーンで徴収するための金額分割。
//
// 顧客は source チェーンで:
//   1. `feeAmount` を operator (env.feeReceiver) へ ERC20 transfer
//   2. `bridgedAmount` (= amount - feeAmount) を merchant 宛にブリッジ (burn)
// を行う。顧客の USDC 総支出は `amount` (請求額) と一致し、通常決済と同じ
// (OpenPay 利用料は店主負担・顧客には不可視)。merchant は bridgedAmount から
// Circle のブリッジ手数料を引かれた額を受領する。
//
// 注: native ガス (ETH/POL) は顧客が EOA で別途負担する (cross-chain は paymaster
// 非経由)。この util は USDC 建ての金額分割のみを扱う。
import { calcFee, type PayMode } from '../fee';
import type { TokenSymbol } from '../tokens';

export interface CrossChainFeeSplit {
  /** operator (feeReceiver) へ source チェーンで送金する OpenPay 利用料 (atomic) */
  feeAmount: bigint;
  /** merchant 宛にブリッジする額 (= burn value, atomic)。Circle ブリッジ手数料は
   *  この額から差し引かれて mint される。 */
  bridgedAmount: bigint;
}

// amount を OpenPay 利用料 (feeAmount) とブリッジ額 (bridgedAmount) に分割する。
// feeAmount + bridgedAmount === amount が常に成り立つ (顧客支出 = 請求額)。
// 極小額で calcFee が整数除算により 0 に潰れる場合は feeAmount=0 となり、
// 呼び出し側 (execute) は fee transfer を skip する (useStandardPayment と同じ扱い)。
export function computeCrossChainFeeSplit(
  amount: bigint,
  token: TokenSymbol,
  mode: PayMode,
): CrossChainFeeSplit {
  if (amount <= 0n) {
    return { feeAmount: 0n, bridgedAmount: 0n };
  }
  const feeAmount = calcFee(amount, token, mode);
  return { feeAmount, bridgedAmount: amount - feeAmount };
}
