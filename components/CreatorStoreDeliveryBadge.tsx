import { useTranslations } from 'next-intl';

// A configured seller destination, not audited protection or guaranteed availability.
// 文言は「購入・保有を確認してから配布」: 譲渡可のライセンスは購入記録のない NFT 保有者にも配布する
// (lib/x402/storeContentAccess.ts の holder・規約 13 条 (18))。「購入者だけ」とは言い切らない。
export function CreatorStoreDeliveryBadge({ protectedDelivery }: { protectedDelivery?: boolean }) {
  const t = useTranslations('CreatorStorefront');
  if (protectedDelivery !== true) return null;
  return <span className="mt-2 inline-block w-fit rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">{t('protectedDeliveryBadge')}</span>;
}
