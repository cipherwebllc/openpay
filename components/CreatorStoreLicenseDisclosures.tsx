import { useTranslations } from 'next-intl';
import type { StoreLicenseSummary, SellerRole } from '@/lib/licenseUi';

export function CreatorStoreLicenseDisclosures({ license, sellerDisclosureHref, sellerRole, sellerName }: {
  license: StoreLicenseSummary;
  sellerDisclosureHref: string;
  sellerRole?: SellerRole;
  sellerName?: string;
}) {
  const t = useTranslations('CreatorStoreLicense');
  const tp = useTranslations('CreatorStorePurchase');
  return (
    <dl className="mt-3 divide-y divide-slate-200 rounded-2xl border border-slate-200 px-4 text-sm text-slate-800">
      <div className="py-3">
        <dt className="font-bold">{t('providerLabel')}</dt>
        <dd>
          <a href={sellerDisclosureHref} className="inline-flex min-h-11 items-center font-semibold text-indigo-800 underline underline-offset-2">
            {sellerRole === 'operator' ? t('sellerOperator') : sellerRole === 'third_party' ? (sellerName ? t('sellerThirdParty', { name: sellerName }) : t('providerThirdParty')) : t('providerUnverified')}
          </a>
          {sellerRole ? <p className="leading-relaxed">{t(sellerRole === 'operator' ? 'providerOperatorNote' : 'providerThirdPartyNote')}</p> : null}
        </dd>
      </div>
      <div className="py-3"><dt className="font-bold">{tp('paymentTimingLabel')}</dt><dd className="mt-1 leading-relaxed">{tp('paymentTimingValue')}</dd></div>
      <div className="py-3">
        <dt className="font-bold">{t('scopeLabel')}</dt>
        <dd className="mt-1 leading-relaxed">
          <p>{t('scopeBody')}</p>
          <a href={license.termsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-indigo-800 underline underline-offset-2">{t('termsLink', { version: license.termsVersion })}</a>
        </dd>
      </div>
      {[
        ['meteredLabel', 'meteredBody'],
        ['issueLabel', 'issueBody'],
        ['refundLabel', 'refundBody'],
        ['transferLabel', license.transferable ? 'transferBody' : 'nonTransferBody'],
        ['publicLabel', 'publicBody'],
      ].map(([label, body]) => (
        <div key={label} className="py-3">
          <dt className="font-bold">{t(label)}</dt>
          <dd className="mt-1 leading-relaxed">{label === 'issueLabel' ? <p className="mb-1">{t('deliveryNotice')}</p> : null}{t(body)}</dd>
        </div>
      ))}
    </dl>
  );
}
