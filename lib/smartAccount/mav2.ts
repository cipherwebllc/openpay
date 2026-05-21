// Alchemy Modular Account v2 (EIP-7702 委任先) を使う SmartAccount client
// adapter。HashPort wallet (内部 Alchemy Account Kit) ユーザのように EOA が
// 既に MAv2 へ 7702 委任済みのケースで動く。
//
// 設計方針:
// - Bundler / Paymaster は引き続き **Pimlico** を共有する (account 層だけ差替)。
//   Pimlico の bundler endpoint は ERC-7677 (`pm_getPaymasterStubData` /
//   `pm_getPaymasterData`) を同 URL で expose しているので、aa-sdk の
//   `erc7677Middleware()` をそのまま使うと sponsorship policy も erc20
//   token paymaster も透過に動く。
// - permissionless 経路の `sendUserOperation({ calls })` 互換 API を露出して
//   `useBatchPayment` 以下の consumer は無変更で動かす。aa-sdk の native API
//   は `{ uo: [{ target, data, value }] }` なので map する。
// - phase 1 では sponsorship (JPYC) のみ。USDC ERC20 paymaster + MAv2 は
//   組合せ未検証のため `IncompatibleSmartAccountError` に倒す (plan §10)。
// - Pimlico bundler が MAv2 sender を実際に accept するかは publicly 未保証
//   (調査 task #22 / R1)。Polygon Amoy + HashPort 実機 smoke で確証取るまで
//   feature flag (NEXT_PUBLIC_ENABLE_MAV2) で OFF が default。

import {
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  createSmartAccountClient as createAaSmartAccountClient,
  WalletClientSigner,
  erc7677Middleware,
  split,
  type ClientMiddlewareFn,
} from '@aa-sdk/core';
import { createModularAccountV2 } from '@account-kit/smart-contracts';
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
import type { SmartAccountBundle } from '@/lib/smartAccount/simpleAccount';

type ConnectedWalletClient = NonNullable<GetWalletClientReturnType>;

type Mav2BatchCall = { to: Address; data: Hex; value?: bigint };

type Mav2SmartAccountClientFacade = {
  sendUserOperation: (params: { calls: Mav2BatchCall[] }) => Promise<Hex>;
};

export async function buildMav2SmartAccountClient(args: {
  walletClient: ConnectedWalletClient;
  publicClient: PublicClient;
  chain: Chain;
  chainId: number;
  deployment: TokenDeployment;
}): Promise<SmartAccountBundle> {
  const { walletClient, publicClient, chain, chainId, deployment } = args;
  const paymasterMode = resolvePaymasterMode(deployment);

  // Pimlico Kaia は MAv2 非対応 (Simple Account / Safe / Thirdweb のみ)。
  // Kaia/Kairos で MAv2 経路に来たら Polygon フォールバックを caller に任せる。
  if (chainId === kaia.id || chainId === kairos.id) {
    throw new IncompatibleSmartAccountError({
      delegateAddress: null,
      i18nKey: 'errorIncompatibleSmartAccount',
    });
  }

  // phase 1: USDC ERC20 paymaster + MAv2 は未検証のため拒否する。
  // sponsorship (JPYC) のみ通す。USDC + MAv2 の解放は smoke (plan Step 9 (f))
  // 完了後に別 commit で。
  if (paymasterMode === 'erc20') {
    throw new IncompatibleSmartAccountError({
      delegateAddress: null,
      i18nKey: 'errorIncompatibleSmartAccount',
    });
  }

  const pimlicoClient = createPimlico(chainId);
  const paymasterContext = pimlicoPaymasterContext(deployment);

  // Pimlico bundler endpoint は ERC-4337 + ERC-7677 (pm_*) + pimlico_* のみで、
  // 標準 eth_* (eth_getCode / eth_getTransactionCount / eth_call) は expose
  // しない。aa-sdk の SmartAccountClient は同一 transport で bundler ops と
  // chain reads の両方を行うため、bundler URL をそのまま渡すと chain reads が
  // "method does not exist" で reject される (HashPort 実機 2026-05-10 観測)。
  // → split transport で method 名で route 分け:
  //   - bundler / paymaster methods → Pimlico
  //   - その他 (eth_*) → chain RPC (publicClient と同じ endpoint)
  const bundlerOnlyTransport: Transport = http(pimlicoUrl(chainId));
  const chainRpcUrl =
    (publicClient.transport as { url?: string }).url ??
    chain.rpcUrls.default.http[0];
  const chainTransport: Transport = http(chainRpcUrl);
  const splitTransport: Transport = split({
    overrides: [
      {
        methods: [
          // ERC-4337 bundler RPC
          'eth_sendUserOperation',
          'eth_estimateUserOperationGas',
          'eth_getUserOperationReceipt',
          'eth_getUserOperationByHash',
          'eth_supportedEntryPoints',
          // Pimlico 拡張
          'pimlico_getUserOperationGasPrice',
          'pimlico_sendUserOperationNow',
          // ERC-7677 paymaster (Pimlico は同 URL で expose)
          'pm_getPaymasterStubData',
          'pm_getPaymasterData',
        ],
        transport: bundlerOnlyTransport,
      },
    ],
    fallback: chainTransport,
  });

  // wagmi の WalletClient を aa-sdk の SmartAccountSigner に wrap。
  // signMessage / signTypedData / signAuthorization を提供する。
  const signer = new WalletClientSigner(walletClient, 'wagmi');

  // EOA はすでに 7702 で MAv2 に委任済 (caller が detectAccountKind で確認)。
  // mode: '7702' で createModularAccountV2 を構築すると account.address は
  // signer.getAddress() (= EOA) と等しくなる。
  const account = await createModularAccountV2({
    transport: chainTransport,
    chain,
    signer,
    mode: '7702',
  });

  // Pimlico bundler URL は ERC-7677 paymaster method を同 endpoint で expose。
  // erc7677Middleware が pm_getPaymasterStubData / pm_getPaymasterData を
  // 自動で呼ぶ。context は sponsorship なら { sponsorshipPolicyId: ... }。
  const paymasterMiddleware = erc7677Middleware({
    context: async () => paymasterContext as Record<string, unknown>,
  });

  // fee: Pimlico の standard tier を使う (gas quote 側と同 tier に揃え、見積と
  // 実費を一致させる)。fast は priority fee が過剰で小額決済の UX 悪化要因。
  // assertGasCeiling は呼び出し元 (useBatchPayment) で別途行う。
  const feeEstimator: ClientMiddlewareFn = async (struct) => {
    const gasPrice = await pimlicoClient.getUserOperationGasPrice();
    return {
      ...struct,
      maxFeePerGas: gasPrice.standard.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.standard.maxPriorityFeePerGas,
    };
  };

  const aaClient = createAaSmartAccountClient({
    chain,
    transport: splitTransport,
    account,
    feeEstimator,
    ...paymasterMiddleware,
  });

  const facade: Mav2SmartAccountClientFacade = {
    sendUserOperation: async ({ calls }) => {
      // permissionless の `{ calls: [{ to, data, value }] }` から
      // aa-sdk の `{ uo: [{ target, data, value }] }` 形式へ変換。
      // OpenPay は常に batch (merchant + fee の最低 2 件) なので array で渡す。
      const uo = calls.map((c) => ({
        target: c.to,
        data: c.data,
        value: c.value,
      }));
      const { hash } = await aaClient.sendUserOperation({ uo });
      return hash;
    },
  };

  return {
    // facade を SmartAccountBundle 型に流し込む。本物の SmartAccountClient
    // ではないが、useBatchPayment が呼ぶのは sendUserOperation のみなので
    // 型上の不整合は cast で吸収する (consumer 側に変更を入れないための妥協)。
    smartAccountClient: facade as unknown as SmartAccountBundle['smartAccountClient'],
    pimlicoClient,
    paymasterMode,
  };
}
