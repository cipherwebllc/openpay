import { env } from '@/lib/env';
import { slugForChain } from '@/lib/chains';
import { mobileOrderFeeValue, standardMobileOrderFeeMinimum, type FeePayer, type MobileOrderFeeKind } from '@/lib/mobileOrderFee';

export type StandardFeeConfig = {
  kind: MobileOrderFeeKind;
  feePayer: FeePayer;
};

export function resolveStandardFeeConfig(
  storefront: {
    chain: string;
    chains?: string[];
    mode: MobileOrderFeeKind;
    feePayer: FeePayer;
  } | undefined,
  chainId: number,
): StandardFeeConfig | null {
  if (!env.enableMobileOrderFee || !storefront) return null;
  const chainSlug = slugForChain(chainId);
  const configuredChains = storefront.chains ?? [storefront.chain];
  // 別 chain の storefront 設定を流用して fee obligation を作る波及を断つ。公開済み受取 chain のみ対象。
  if (!chainSlug || !configuredChains.includes(chainSlug)) return null;
  return { kind: storefront.mode, feePayer: storefront.feePayer };
}

type StandardFeeObligation = {
  expected: bigint;
  alternate?: bigint;
  collectedInline: boolean;
};

export function standardFeeObligationFromReceipt(args: {
  receiptValue: bigint;
  sameSourceFeeValue?: bigint;
  config: StandardFeeConfig | null;
}): StandardFeeObligation | null {
  if (!args.config) return null;
  const fee = standardMobileOrderFeeMinimum(
    args.receiptValue,
    args.config.kind,
    args.config.feePayer,
  );
  if (fee <= 0n) return null;
  const merchantBorne =
    args.config.kind !== 'preorder' ||
    args.config.feePayer !== 'customer';
  const alternate = fee + 1n;
  const alternateGross = args.receiptValue + alternate;
  const hasAlternate =
    merchantBorne &&
    mobileOrderFeeValue(alternateGross, args.config.kind) === alternate &&
    alternateGross - alternate === args.receiptValue;
  // merchant 着金全額と同じ Transfer source が同一 receipt 内で feeReceiver に期待額以上を
  // 払った atomic relay/batch だけを徴収済みとする。receipt.from 不一致の helper/4337 支払いで
  // standard 判定を避け、fee 未払いを通常受注へ落とす迂回の波及を断つ。
  return {
    expected: fee,
    ...(hasAlternate ? { alternate } : {}),
    collectedInline: (args.sameSourceFeeValue ?? 0n) >= fee,
  };
}

