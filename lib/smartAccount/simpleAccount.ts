// Pimlico SimpleAccount (7702) 経路の SmartAccount client builder。
// 既存 hooks/useSmartAccount.ts の queryFn 内ロジックを純粋関数として抽出した
// もの。振る舞い無変更 (importable 形にしただけ)。
//
// AccountKind が 'none' (空 EOA) または 'pimlico-simple-7702' (既に Pimlico
// SimpleAccount に委任済) のときに使う。

import { http, type PublicClient } from 'viem';
import { createSmartAccountClient, type SmartAccountClient } from 'permissionless';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import { prepareUserOperationForErc20Paymaster } from 'permissionless/experimental/pimlico';
import type { GetWalletClientReturnType } from '@wagmi/core';
import {
  createPimlico,
  pimlicoPaymasterContext,
  pimlicoUrl,
  resolvePaymasterMode,
} from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

export type SimpleAccountClient = SmartAccountClient;

export type SmartAccountBundle = {
  smartAccountClient: SimpleAccountClient;
  pimlicoClient: ReturnType<typeof createPimlico>;
  paymasterMode: 'sponsorship' | 'erc20';
};

// wagmi の useWalletClient().data は WalletClient<..., ..., Account> (account 必須)。
// viem の生 WalletClient だと account が optional なので、wagmi 由来の型を使う。
type ConnectedWalletClient = NonNullable<GetWalletClientReturnType>;

export async function buildSimpleSmartAccountClient(args: {
  walletClient: ConnectedWalletClient;
  publicClient: PublicClient;
  chainId: number;
  deployment: TokenDeployment;
}): Promise<SmartAccountBundle> {
  const { walletClient, publicClient, chainId, deployment } = args;
  const pimlicoClient = createPimlico(chainId);
  const paymasterMode = resolvePaymasterMode(deployment);

  const account = await to7702SimpleSmartAccount({
    client: publicClient,
    owner: walletClient,
  });

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: walletClient.chain,
    bundlerTransport: http(pimlicoUrl(chainId)),
    paymaster: pimlicoClient,
    paymasterContext: pimlicoPaymasterContext(deployment),
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
      prepareUserOperation:
        paymasterMode === 'erc20'
          ? prepareUserOperationForErc20Paymaster(pimlicoClient)
          : undefined,
    },
  });

  return { smartAccountClient, pimlicoClient, paymasterMode };
}
