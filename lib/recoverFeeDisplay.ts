// Recover モードの手数料開示ラベルを組み立てる純ヘルパー。
// 表示ロジックをコンポーネントから切り離し、テスト可能にする。
// 計算は一切行わない: recoverFeeValue / recoverFeeBps / relayGasFeeValue を消費するだけ。

import { formatUnits } from 'viem';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';

export type RecoverFeeDisplay = {
  /** 手数料の人間可読額 (JPYC 単位, 小数文字列)。 */
  feeHuman: string;
  /** bps > 0 の場合のみ: floor の人間可読額。 */
  floorHuman: string;
  /** bps。0 = ガス固定、>0 = % 形式。 */
  bps: number;
  /** 顧客支払額の人間可読額 (customer 負担時 = amount + fee)。 */
  customerPaysHuman: string;
  /** 店主受取額の人間可読額 (merchant 負担時 = amount - fee)。 */
  merchantReceivesHuman: string;
  /** gasMode = 'customer' か 'merchant' か。 */
  gasMode: 'customer' | 'merchant';
};

/**
 * Recover モードが有効な chain に対し、手数料開示の数値ブロックを返す。
 * forwarder 未設定 (free モード) または billAmount = 0n の場合は null を返す (開示不要)。
 */
export function buildRecoverFeeDisplay(
  billAmount: bigint,
  chainId: number,
  gasMode: 'customer' | 'merchant',
): RecoverFeeDisplay | null {
  if (jpycForwarderFor(chainId) === null) return null;
  if (billAmount <= 0n) return null;

  const fee = recoverFeeValue(billAmount);
  const floor = relayGasFeeValue();
  const bps = recoverFeeBps();

  const feeHuman = formatUnits(fee, 18);
  const floorHuman = formatUnits(floor, 18);

  const customerPaysHuman =
    gasMode === 'customer'
      ? formatUnits(billAmount + fee, 18)
      : formatUnits(billAmount, 18);

  const merchantReceivesHuman =
    gasMode === 'merchant'
      ? formatUnits(billAmount - fee, 18)
      : formatUnits(billAmount, 18);

  return { feeHuman, floorHuman, bps, customerPaysHuman, merchantReceivesHuman, gasMode };
}
