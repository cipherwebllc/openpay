import 'server-only';

// purchase の grant / 購入 record を intent から組み立てる builder (R3c)。finalize (保存する値) と
// settled access の読み取り (照合する期待値) の両方が使うので、両者より下に置いて循環を断つ
// (finalize → library → records の一方向)。facade からは export しない。
import type { Hex } from 'viem';
import {
  PURCHASE_INTENT_VERSION,
  type ClaimedPurchaseIntentBase,
  type HostedPurchaseRecord,
  type PurchaseGrant,
} from './types';

export function purchaseGrant(
  intent: ClaimedPurchaseIntentBase,
  txHash: Hex,
  purchasedAt: number,
): PurchaseGrant {
  return {
    intentSalt: intent.intentSalt,
    contentRevision: intent.contentRevision,
    contentRef: intent.contentRef,
    metadata: intent.metadata,
    chainId: intent.chainId,
    txHash,
    nonce: intent.claim.nonce,
    purchasedAt,
  };
}

export function purchaseRecord(
  intent: ClaimedPurchaseIntentBase,
  txHash: Hex,
  purchasedAt: number,
): HostedPurchaseRecord {
  return {
    version: PURCHASE_INTENT_VERSION,
    payer: intent.claim.payer,
    resourceId: intent.resourceId,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeReceiver: intent.feeReceiver,
    feeValue: intent.feeValue,
    token: intent.token,
    forwarder: intent.forwarder,
    commitVersion: intent.commitVersion,
    deploymentVersion: intent.deploymentVersion,
    ...purchaseGrant(intent, txHash, purchasedAt),
  };
}
