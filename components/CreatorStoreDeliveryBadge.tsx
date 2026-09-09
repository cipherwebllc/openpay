import { useTranslations } from 'next-intl';

// A configured seller destination, not audited protection or guaranteed availability.
export function CreatorStoreDeliveryBadge({ protectedDelivery }: { protectedDelivery?: boolean }) {
  const t = useTranslations('CreatorStorefront');
  if (protectedDelivery !== true) return null;
  return <span className="mt-2 inline-block w-fit rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">{t('protectedDeliveryBadge')}</span>;
}
