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

/**
 * 注文リンクの支払いの指紋 (第 9 回レビュー G-1)。CheckoutForm が注文リンク (isRemoteOrderCheckout) の支払いにだけ
 * 復旧 intent へ残し、読み直した後の完了を「この注文リンク」の支払いにだけ結び付ける。上の指紋は ship を含まないので、
 * 同じお店・明細・金額の普通の /checkout と「何度でも使える」リンク (ship=ask) が同じ値になる。既存の照合
 * (restoredStandardOrderAttempt) の意味を変えないよう、上の指紋は変えずに注文リンクであることと ship を別に束ねる。
 */
export function orderLinkContextFingerprint(contextKey: Hex, params: Pick<CheckoutParams, 'ship'>): Hex {
  const values: readonly CanonicalValue[] = [
    'openpay.intent.order-link.v1',
    contextKey.toLowerCase(),
    params.ship ?? null,
  ];
  return keccak256(toHex(JSON.stringify(values)));
}
