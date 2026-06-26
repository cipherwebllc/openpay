// x402 PaymentRequirements (exact scheme) を JPYC + OpenPay forwarder 分割向けに生成する helper (F)。
//
// 標準 x402 `exact` は単一 transferWithAuthorization(to=payTo) で手数料ゼロ。OpenPay は 1% を
// **非カストディ**に取るため、buyer は receiveWithAuthorization(to=forwarder, value=price+fee,
// nonce=分割コミットメント) に 1 回署名し、forwarder.settle が 1 tx で merchant/feeReceiver へ
// アトミック分割する (lib/relay/forwarderIntent / forwarderSettle を facilitator が再利用)。
// この差分は extra.openpay で明示する:
//   - wire の payTo   = forwarder (buyer が署名する on-chain の to・facilitator が照合する値)
//   - 実 seller       = extra.openpay.merchant (表示額 merchantValue の受領先)
//   - 手数料先        = extra.openpay.feeReceiver / feeValue
//   - maxAmountRequired = merchantValue + feeValue (= buyer の総署名額)
// vanilla x402 client (単一 auth) 互換は Phase 2 (OpenPay client が extra.openpay を読んで署名)。

import { getAddress, type Address, type Hex } from 'viem';
import { JPYC_V3_ASSET } from './types';
import { x402FacilitatorConfig } from './facilitatorConfig';
import { x402FeeBreakdown } from './fee';
import { caip2ForChainId } from './network';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { resolveDeployment } from '@/lib/tokens';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

// EIP-712 domain メタ (buyer が typed data を組むため・jpyc-x402 互換の extra)。
export type X402AssetMeta = {
  name: string;
  version: string;
  decimals: number;
};

// OpenPay forwarder 分割の記述子 (extra.openpay)。buyer がこれを読んで ForwarderSettleParams を
// 組み receiveWithAuthorization を署名する。facilitator は payload をこの値と server 権威で照合する。
export type X402OpenPaySplit = {
  mode: 'forwarder-split';
  forwarder: Address;
  merchant: Address; // 実 seller (表示額の受領先)
  merchantValue: string; // atomic JPYC (= price)
  feeReceiver: Address;
  feeValue: string; // atomic JPYC (= x402FeeValue(price))
  commitVersion: Hex; // FORWARDER_COMMIT_VERSION (nonce 構築の version)
};

export type X402PaymentRequirements = {
  scheme: 'exact';
  network: string; // CAIP-2 (eip155:137 / eip155:80002)
  maxAmountRequired: string; // atomic (merchantValue + feeValue) = buyer の総署名額
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address; // = forwarder (buyer が署名する on-chain の to)
  maxTimeoutSeconds: number;
  asset: Address; // JPYC token contract
  extra: X402AssetMeta & {
    assetTransferMethod: 'eip3009';
    openpay: X402OpenPaySplit;
  };
};

export type CreateJpycRequirementsInput = {
  amount: bigint; // price (atomic JPYC wei)・seller が受け取る表示額・必須 > 0
  payTo: Address; // 実 seller
  resource: string;
  description: string;
  chainId?: number; // 既定 = facilitator の対象 chain (NETWORK_ENV 依存)
  mimeType?: string;
  maxTimeoutSeconds?: number;
};

const DEFAULT_MAX_TIMEOUT_SECONDS = 600; // 10 分 (buyer が署名→提出するまでの猶予)

// fee 込みの x402 `accepts[]` を生成する (acceptance F)。Phase 1 は 1 要素 (JPYC exact / Polygon)。
// 誤設定 (amount<=0 / forwarder 未設定 / JPYC 未 deploy / feeReceiver=burn) は throw して
// 壊れた requirements を返さない (resource server が loud に失敗する)。
export function createJpycPaymentRequirements(
  input: CreateJpycRequirementsInput,
): X402PaymentRequirements[] {
  if (input.amount <= 0n) {
    throw new Error('x402: amount must be > 0');
  }
  const chainId = input.chainId ?? x402FacilitatorConfig.chainId;

  const forwarder = configuredJpycForwarderFor(chainId);
  if (forwarder === null) {
    throw new Error(`x402: forwarder unconfigured for chain ${chainId}`);
  }
  const jpyc = resolveDeployment('jpyc', chainId);
  if (jpyc === undefined) {
    throw new Error(`x402: JPYC unavailable on chain ${chainId}`);
  }
  if (!x402FacilitatorConfig.feeReceiverConfigured) {
    throw new Error('x402: fee receiver unconfigured');
  }

  const { merchantValue, feeValue, total } = x402FeeBreakdown(input.amount);

  const pr: X402PaymentRequirements = {
    scheme: 'exact',
    network: caip2ForChainId(chainId),
    maxAmountRequired: total.toString(),
    resource: input.resource,
    description: input.description,
    mimeType: input.mimeType ?? '',
    payTo: forwarder,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    asset: jpyc.address,
    extra: {
      name: JPYC_V3_ASSET.eip712.name,
      version: JPYC_V3_ASSET.eip712.version,
      decimals: jpyc.decimals,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder,
        merchant: getAddress(input.payTo),
        merchantValue: merchantValue.toString(),
        feeReceiver: x402FacilitatorConfig.feeReceiver,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
  return [pr];
}
