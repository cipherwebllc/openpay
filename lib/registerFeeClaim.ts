import 'server-only';

import { createPublicClient, getAddress, type Address, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { verifyJpycStandardFeePairOnChain } from '@/lib/feeVerify';
import { kvEval, kvGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  CLAIM_PAYMENT_UNLESS_LEGACY_BILLING,
  legacyBillingPaymentKey,
  paymentClaimKey,
  paymentClaimResultValue,
} from '@/lib/paymentClaim';
import { recoverPercentValue } from '@/lib/relay/recoverFee';
import { resolveDeployment } from '@/lib/tokens';

export type RegisterFeeClaimInput = {
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  saleAmount: bigint;
  merchantTxHash: Hex;
  feeTxHash: Hex;
};

export type RegisterFeeClaimResult =
  | 'claimed'
  | 'replay'
  | 'conflict'
  | 'invalid'
  | 'verify_failed'
  | 'kv_error';

/**
 * レジ standard fee (2 tx 分割の fee leg) の用途束縛 claim。
 *
 * client の申告は「どの 2 本の tx か」だけで、金額・payer・順序はすべて on-chain から導く:
 * 既存 `verifyJpycStandardFeePairOnChain` を再利用し (1) 両 receipt が success、(2) 同一 payer
 * (receipt.from 一致)、(3) fee tx が merchant tx より後、(4) merchant leg = saleAmount - fee の
 * exact、(5) fee leg = server が定数から再計算した fee の exact を確認する。
 *
 * 成功したら `payment:claimed:{chainId}:{feeTxHash}` を用途 'register' で恒久確保する。
 * 注文側の reconciliation は同じキーを見るため、この fee tx を別注文の未収解除へ流用できない
 * (= register→order の二重充当を塞ぐ)。注文側の検証ロジックは一切変えていない。
 */
export async function claimRegisterFeePayment(
  input: RegisterFeeClaimInput,
): Promise<RegisterFeeClaimResult> {
  if (!env.enableRegisterFee || !env.feeReceiverConfigured) return 'invalid';
  const chain = chainObjectForId(input.chainId);
  const deployment = resolveDeployment('jpyc', input.chainId);
  if (
    !chain ||
    !deployment ||
    getAddress(input.tokenAddress) !== getAddress(deployment.address)
  ) {
    return 'invalid';
  }
  if (input.merchantTxHash.toLowerCase() === input.feeTxHash.toLowerCase()) {
    return 'invalid';
  }

  // レジ standard の利用料は client と同式 (recover の % 部分) を server が再計算する。
  // client 申告の額は使わない。
  const feeValue = recoverPercentValue(input.saleAmount);
  const merchantValue = input.saleAmount - feeValue;
  if (feeValue <= 0n || merchantValue <= 0n) return 'invalid';

  const publicClient = createPublicClient({
    chain,
    transport: transportForChain(input.chainId),
  });
  const verified = await verifyJpycStandardFeePairOnChain({
    publicClient,
    merchantTxHash: input.merchantTxHash,
    feeTxHash: input.feeTxHash,
    expected: {
      token: deployment.address,
      merchant: getAddress(input.merchant),
      merchantValue,
      feeReceiver: getAddress(env.feeReceiver),
      feeMinValue: feeValue,
    },
  });
  if (!verified.ok) {
    logger.warn('register.fee_claim_verify_failed', {
      chainId: input.chainId,
      reason: verified.reason,
    });
    return 'verify_failed';
  }

  const claimKey = paymentClaimKey(input.chainId, input.feeTxHash);
  const claimValue = paymentClaimResultValue('register');
  const claimed = await kvEval<number>(
    CLAIM_PAYMENT_UNLESS_LEGACY_BILLING,
    [claimKey, legacyBillingPaymentKey(input.chainId, input.feeTxHash)],
    [claimValue],
  );
  if (!claimed.ok) {
    logger.warn('register.fee_claim_kv_error', {
      chainId: input.chainId,
      reason: claimed.reason,
    });
    return 'kv_error';
  }
  if (claimed.value === 1) return 'claimed';
  if (claimed.value === 0) {
    // 同じ fee tx の再通知 (リトライ/リロード) は replay。別用途が先に取っていれば conflict。
    const existing = await kvGet(claimKey);
    if (!existing.ok) {
      logger.warn('register.fee_claim_kv_error', {
        chainId: input.chainId,
        reason: existing.reason,
      });
      return 'kv_error';
    }
    if (existing.value === claimValue) return 'replay';
  }
  return 'conflict';
}
