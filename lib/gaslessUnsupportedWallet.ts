// 署名の前に、つないだアドレスが JPYC のガスレス (EIP-3009) で払えない contract の口座かを、支払うチェーンの code で読む。
// hooks/useGaslessUnsupportedWallet.ts から遅延 import する (First Load JS に載せない・bundle 予算)。
// テストは tests/setup.ts で「読めない」スタブに差し替える (外の RPC を叩かない・fetch を差し替えたテストに RPC の POST を
// 混ぜない)。実物の動きは tests/lib/gaslessUnsupportedWallet.test.ts が確かめる。

import { createPublicClient, type Address, type Hex } from 'viem';
import { isNonDelegatedContractCode } from '@/lib/accountCode';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { logger } from '@/lib/logger';

export type GaslessUnsupportedWalletPath = 'pay' | 'checkout' | 'store-device';

type CodeReader = (chainId: number, address: Address) => Promise<Hex | undefined>;

const readCode: CodeReader = async (chainId, address) => {
  const chain = chainObjectForId(chainId);
  if (!chain) throw new Error(`no chain object: ${chainId}`);
  return createPublicClient({ chain, transport: transportForChain(chainId) }).getCode({ address });
};

/**
 * 7702 の委任でない code を持つ (= JPYC の EIP-3009 は ecrecover だけで、この口座の署名は通らない) なら true。
 * code の無い EOA (未 deploy のスマートアカウントを含む) と 7702 で委任した EOA は false (lib/accountCode.ts)。
 * 読めなければ reject する (呼び出し側が fail-open で false にする)。
 */
export async function readGaslessUnsupportedWallet(
  chainId: number,
  address: Address,
  path: GaslessUnsupportedWalletPath,
  reader: CodeReader = readCode,
): Promise<boolean> {
  const unsupported = isNonDelegatedContractCode(await reader(chainId, address));
  // 開発時の確認用の log (アドレスは出さない)。本番の既定の level (warn・lib/logger.ts) では出ず、Sentry にも送らない =
  // 件数は数えていない。欄は文字列と数だけなので、logger は throw しない。
  if (unsupported) logger.info('payment.gasless_unsupported_wallet', { path, chainId });
  return unsupported;
}
