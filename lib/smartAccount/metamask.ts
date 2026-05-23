// MetaMask Smart Account (EIP-7702 StatelessDeleGator) を使う SmartAccount
// client adapter。MetaMask が 2025 春から新規 install ユーザに自動適用している
// 7702 委任先 (`0x63c0…32B`) を AccountKind 'metamask-7702' として lib/accountDetection.ts
// で検出した時に使う。
//
// 設計方針:
// - Bundler / Paymaster は引き続き **Pimlico** を共有する (account 層だけ差替)。
// - permissionless 経路の `sendUserOperation({ calls })` 互換 API を露出する
//   ため、@metamask/delegation-toolkit の `toMetaMaskSmartAccount` (viem
//   account-abstraction の SmartAccount を返す) を `createSmartAccountClient`
//   from permissionless にそのまま渡せる。SimpleAccount と同 dispatch shape。
// - Stateless7702 mode: deploy 不要 (EOA は既に MetaMask delegator に委任済)、
//   `address: <eoa>` を渡すと account.address === EOA で動作。
// - 'unavailable' paymasterMode (Ethereum L1 USDC) は到達不可前提だが、
//   simpleAccount.ts / mav2.ts と同じ fail-loud guard を入れる (sponsorship
//   残高悪用の防御線)。
//
// Kaia ガード:
// MetaMask は Kaia (chain id 8217) に delegator を deploy していない
// (Deployments.md 23 mainnet に Kaia 不在、確認 2026-05-24)。万一 Kaia chain で
// 'metamask-7702' kind が detect された (= 別 chain で委任した delegate code が
// 残った状態等の異常ケース) には fail-safe で `errorMetaMaskKaia` に倒す。
//
// 出典: https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md
//       https://docs.pimlico.io/guides/how-to/accounts/use-metamask-account
//       https://docs.metamask.io/smart-accounts-kit/get-started/smart-account-quickstart/eip7702/

import { http, type Address, type PublicClient } from 'viem';
import { createSmartAccountClient } from 'permissionless';
import { prepareUserOperationForErc20Paymaster } from 'permissionless/experimental/pimlico';
import {
  Implementation,
  toMetaMaskSmartAccount,
} from '@metamask/delegation-toolkit';
import { kaia, kairos } from 'viem/chains';
import type { GetWalletClientReturnType } from '@wagmi/core';
import {
  createPimlico,
  pimlicoPaymasterContext,
  pimlicoUrl,
  resolvePaymasterMode,
} from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';
import { IncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import type { SmartAccountBundle } from '@/lib/smartAccount/simpleAccount';

type ConnectedWalletClient = NonNullable<GetWalletClientReturnType>;

export async function buildMetaMaskSmartAccountClient(args: {
  walletClient: ConnectedWalletClient;
  publicClient: PublicClient;
  chainId: number;
  account: Address;
  deployment: TokenDeployment;
}): Promise<SmartAccountBundle> {
  const { walletClient, publicClient, chainId, account, deployment } = args;

  // Kaia chain では MetaMask delegator 未 deploy のため、detection が
  // 'metamask-7702' になることはあり得ない (delegator code が存在しない)。
  // 万一到達した場合は fail-safe で UI 案内に倒す。
  if (chainId === kaia.id || chainId === kairos.id) {
    logger.warn('smart_account.metamask_kaia_rejected', {
      chainId,
      symbol: deployment.symbol,
    });
    throw new IncompatibleSmartAccountError({
      delegateAddress: null,
      i18nKey: 'errorMetaMaskKaia',
    });
  }

  const rawMode = resolvePaymasterMode(deployment);
  // 'unavailable' (USDC on Ethereum L1) は URL parser で gasless 経路から弾かれ
  // ているため、ここに来るのは呼出側の bug。
  if (rawMode === 'unavailable') {
    throw new Error(
      `buildMetaMaskSmartAccountClient: deployment ${deployment.symbol} on chain ${chainId} ` +
        'は gasless mode 非対応 (paymasterMode=unavailable)。standard mode 経路を使うこと。',
    );
  }
  const paymasterMode = rawMode;

  const pimlicoClient = createPimlico(chainId);

  // Stateless7702 mode: EOA は既に MetaMask delegator (0x63c0…32B) に委任済の
  // 前提。account.address === EOA address。signer は walletClient (wagmi 由来)
  // をそのまま渡す = MetaMask が UserOp の userOpHash に EOA 秘密鍵で署名する。
  // toMetaMaskSmartAccount は viem account-abstraction の SmartAccount を返す
  // ため、permissionless の createSmartAccountClient にそのまま渡せる。
  const mmAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: account,
    signer: { walletClient },
  });

  const smartAccountClient = createSmartAccountClient({
    // toMetaMaskSmartAccount の戻りは viem の SmartAccount だが、permissionless
    // の createSmartAccountClient は同 interface を accept する。
    // (entryPoint 0.7、SimpleAccount と同 dispatch shape)
    account: mmAccount as unknown as Parameters<typeof createSmartAccountClient>[0]['account'],
    chain: walletClient.chain,
    bundlerTransport: http(pimlicoUrl(chainId)),
    paymaster: pimlicoClient,
    paymasterContext: pimlicoPaymasterContext(deployment),
    userOperation: {
      // SimpleAccount と同じく standard tier。gas quote と同 tier に揃える。
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).standard,
      prepareUserOperation:
        paymasterMode === 'erc20'
          ? prepareUserOperationForErc20Paymaster(pimlicoClient)
          : undefined,
    },
  });

  return { smartAccountClient, pimlicoClient, paymasterMode };
}
