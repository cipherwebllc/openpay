import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { CheckoutParams } from '@/lib/url';

type CanonicalValue =
  | number
  | string
  | null
  | readonly CanonicalValue[];

/**
 * standard merchant leg の reload 復元を、公開注文文脈へ暗号学的に束縛する。
 * callback URL・customerEmail・秘密値は入力にせず、sessionStorage へは digest だけを渡す。
 */
export function checkoutIntentContextFingerprint({
  params,
  chainId,
  tokenAddress,
  totalAtomic,
}: {
  params: CheckoutParams;
  chainId: number;
  tokenAddress: Address;
  totalAtomic: string;
}): Hex {
  const values: readonly CanonicalValue[] = [
    'openpay.intent.checkout.v2',
    chainId,
    params.token,
    tokenAddress.toLowerCase(),
    params.to.toLowerCase(),
    totalAtomic,
    params.gas,
    params.mode ?? 'gasless',
    params.items.map((item) => [
      item.name,
      item.qty,
      item.price,
      item.taxRate ?? null,
      item.taxCategory ?? null,
      item.memo ?? null,
    ]),
    params.orderId ?? null,
    params.description ?? null,
    params.taxRate ?? null,
    params.taxCategory ?? null,
    params.receiptNo ?? null,
    params.feeKind ?? null,
    params.feePayer ?? null,
    params.storeHandle ?? null,
    params.pickupAt ?? null,
  ];
  return keccak256(toHex(JSON.stringify(values)));
}
