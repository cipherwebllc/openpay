// Circle Paymaster v0.8 (USDC ガスレス) の SmartAccount client builder + 送信
// orchestration。spike (scripts/spike-circle-paymaster.mjs、Arbitrum Sepolia 実機 GO)
// のレシピを本番コードに関数化したもの。
//
// 設計方針:
// - account は viem `toSimple7702SmartAccount` (EntryPoint v0.8)。委任先 impl は
//   viem 既定 = `0xe6Cae83…` = 現行 Pimlico Simple7702 impl と同一 (spike 実証)。
//   → 既に Pimlico 経路で委任済の EOA はそのまま使え、再委任 (= 7702 authorization)
//   不要。pristine EOA は useSmartAccount が手前で errorPristineNoBootstrap に倒すため
//   Circle 経路には到達しない (injected wallet は signAuthorization 非対応)。
// - bundler は Pimlico を共有 (v0.8 対応・spike 確認)。paymaster は Circle (USDC で
//   gas を顧客が支払う・当社徴収0)。
// - **provider/entryPointVersion を discriminant** に持つ CircleSmartAccountBundle を
//   返し、Pimlico (v0.7) bundle との discriminated union (AnySmartAccountBundle) を成す。
//   useBatchPayment は provider で exhaustive 分岐する (計画 C6)。
// - 署名は wagmi walletClient 経由 (permit=popup1、UserOp=popup2 の 2 署名)。
//
// ⚠️ 二重決済対策 (計画 C1) の durable pending store / 冪等 rebroadcast は本 module
//    では扱わない。本 module は「permit 署名」「UserOp 送信」の素の building block を
//    提供し、FSM/idempotency は useBatchPayment 側 (chunk 3) が prepare→persist→
//    broadcast に分解して使う。

import { http, type Address, type Hex, type PublicClient } from 'viem';
import {
  createBundlerClient,
  entryPoint08Address,
} from 'viem/account-abstraction';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import {
  assertCirclePaymasterDeployed,
  assertPermitDomain,
  buildPermitTypedData,
  CIRCLE_MIN_POSTOP_GAS,
  encodeCirclePaymasterData,
  normalizePermitSignature,
  readPermitDomain,
  readPermitNonce,
  requireCirclePaymasterAddress,
} from '@/lib/circlePaymaster';
import { pimlicoUrl } from '@/lib/pimlico';
import type { SmartAccountBundle } from '@/lib/smartAccount/simpleAccount';
import type { ConnectedWalletClient } from '@/lib/smartAccount/simpleAccount';
import type { TokenDeployment } from '@/lib/tokens';

// permissionless の 7702 SimpleAccount (EntryPoint v0.8 固定・walletClient owner 可、
// 委任先 impl は viem 既定の 0xe6Cae83 = 現行 Pimlico simple-7702 と同一)。viem の
// toSimple7702SmartAccount は LocalAccount 専用で injected wallet を受けられないため、
// 既存 simpleAccount.ts と同じ permissionless 経路を使う。
export type CircleSmartAccount = Awaited<
  ReturnType<typeof to7702SimpleSmartAccount>
>;
export type CircleBundlerClient = ReturnType<typeof createBundlerClient>;

export type CircleSmartAccountBundle = {
  provider: 'circle';
  entryPointVersion: '0.8';
  account: CircleSmartAccount;
  bundlerClient: CircleBundlerClient;
  chainId: number;
  deployment: TokenDeployment;
  // Circle Paymaster v0.8 アドレス (allowlist SoT 由来・permit spender)。
  paymasterAddress: Address;
};

/** Pimlico(v0.7) と Circle(v0.8) を provider で判別する discriminated union。
 * useSmartAccount の戻り値型 (chunk 3 で wiring)。 */
export type AnySmartAccountBundle = SmartAccountBundle | CircleSmartAccountBundle;

export type BatchCall = { to: Address; data: Hex; value?: bigint };

/** Circle Paymaster v0.8 経路の bundle を構築。allowlist のアドレスに contract code
 * が在ることを検証してから返す (C3 runtime guard)。 */
export async function buildCircleSmartAccountClient(args: {
  walletClient: ConnectedWalletClient;
  publicClient: PublicClient;
  chainId: number;
  deployment: TokenDeployment;
}): Promise<CircleSmartAccountBundle> {
  const { walletClient, publicClient, chainId, deployment } = args;
  if (deployment.symbol !== 'usdc') {
    throw new Error(
      `buildCircleSmartAccountClient: Circle Paymaster は USDC 専用 (got ${deployment.symbol})`,
    );
  }
  const paymasterAddress = requireCirclePaymasterAddress(chainId);
  // permit spender になる前に allowlist アドレスが実コントラクトであることを確認。
  await assertCirclePaymasterDeployed(publicClient, chainId);

  const account = await to7702SimpleSmartAccount({
    client: publicClient,
    owner: walletClient,
  });

  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: http(pimlicoUrl(chainId)),
  });

  return {
    provider: 'circle',
    entryPointVersion: '0.8',
    account,
    bundlerClient,
    chainId,
    deployment,
    paymasterAddress,
  };
}

/** USDC permit に署名し (popup1)、paymasterData を組む。domain drift を事前検証して
 * permit revert を切り分ける (spike finding)。deadline=MAX 固定。 */
export async function signUsdcPermit(args: {
  publicClient: PublicClient;
  walletClient: ConnectedWalletClient;
  bundle: CircleSmartAccountBundle;
  owner: Address;
  permitAmount: bigint;
}): Promise<{ permitSignature: Hex; paymasterData: Hex }> {
  const { publicClient, walletClient, bundle, owner, permitAmount } = args;
  const token = bundle.deployment.address;

  const domain = await readPermitDomain(publicClient, token);
  assertPermitDomain(domain, { chainId: bundle.chainId, token });
  const nonce = await readPermitNonce(publicClient, token, owner);

  const typedData = buildPermitTypedData({
    domain,
    owner,
    spender: bundle.paymasterAddress,
    value: permitAmount,
    nonce,
  });

  const raw = await walletClient.signTypedData({
    account: owner,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
  const permitSignature = normalizePermitSignature(raw);
  const paymasterData = encodeCirclePaymasterData({
    token,
    permitAmount,
    permitSignature,
  });
  return { permitSignature, paymasterData };
}

/** Pimlico の standard tier fee。Arbitrum 等は maxPriorityFeePerGas に下限が在るため
 * viem 既定の fee 推定では弾かれる (spike)。bundler の pimlico_getUserOperationGasPrice
 * を使う (本番 simpleAccount.ts も同 tier)。 */
export async function getCircleUserOpGasPrice(
  bundle: CircleSmartAccountBundle,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  // pimlico_getUserOperationGasPrice は viem の RPC 型に無い Pimlico 拡張なので
  // request を緩く cast して呼ぶ。
  const request = bundle.bundlerClient.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<{ standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>;
  const gp = await request({
    method: 'pimlico_getUserOperationGasPrice',
    params: [],
  });
  return {
    maxFeePerGas: BigInt(gp.standard.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(gp.standard.maxPriorityFeePerGas),
  };
}

/** Circle paymasterData 入りで gas を見積もる。paymasterPostOpGasLimit は Circle 固定
 * 下限 (15000) 以上を強制する (未満は AA33 0x5ff4afc1 revert・spike)。完全な gas セットを
 * 返す (postOp だけ部分指定すると viem "Invalid fields")。 */
export async function estimateCircleUserOp(args: {
  bundle: CircleSmartAccountBundle;
  calls: BatchCall[];
  paymasterData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): Promise<{
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}> {
  const { bundle, calls, paymasterData, maxFeePerGas, maxPriorityFeePerGas } =
    args;
  const est = await bundle.bundlerClient.estimateUserOperationGas({
    account: bundle.account,
    calls,
    paymaster: bundle.paymasterAddress,
    paymasterData,
    paymasterPostOpGasLimit: CIRCLE_MIN_POSTOP_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const postOp =
    est.paymasterPostOpGasLimit && est.paymasterPostOpGasLimit > CIRCLE_MIN_POSTOP_GAS
      ? est.paymasterPostOpGasLimit
      : CIRCLE_MIN_POSTOP_GAS;
  return {
    callGasLimit: est.callGasLimit,
    verificationGasLimit: est.verificationGasLimit,
    preVerificationGas: est.preVerificationGas,
    paymasterVerificationGasLimit: est.paymasterVerificationGasLimit ?? 0n,
    paymasterPostOpGasLimit: postOp,
  };
}

/** Circle UserOp を送信 (popup2 = UserOp 署名)。estimate → fee → 完全 gas セットで
 * sendUserOperation。userOpHash を返す。
 * ⚠️ これは「素の送信」。二重決済耐性 (persist-before-broadcast + 冪等 rebroadcast)
 *    は useBatchPayment の FSM (chunk 3) が担う。本関数を fallback と組み合わせるときは
 *    「broadcast 前 or 決定的 unsupported のみ fallback 可」の制約を呼出側で守ること。 */
export async function sendCircleUserOperation(args: {
  bundle: CircleSmartAccountBundle;
  calls: BatchCall[];
  paymasterData: Hex;
}): Promise<Hex> {
  const { bundle, calls, paymasterData } = args;
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await getCircleUserOpGasPrice(bundle);
  const gas = await estimateCircleUserOp({
    bundle,
    calls,
    paymasterData,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return bundle.bundlerClient.sendUserOperation({
    account: bundle.account,
    calls,
    paymaster: bundle.paymasterAddress,
    paymasterData,
    maxFeePerGas,
    maxPriorityFeePerGas,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit,
  });
}

/** UserOp receipt を待つ。entryPoint=v0.8 / paymaster=Circle の確認は呼出側 (verifier)。 */
export async function waitForCircleReceipt(args: {
  bundle: CircleSmartAccountBundle;
  hash: Hex;
}) {
  return args.bundle.bundlerClient.waitForUserOperationReceipt({
    hash: args.hash,
  });
}

export { entryPoint08Address };
