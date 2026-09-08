import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import type { StoreLicenseProduct } from '@/lib/licenseUi';

// サーバーが在庫から計算した残数のみを使う。取得失敗を在庫ありに見せない。
export function CreatorStoreLicenseDetails({ product }: { product: StoreLicenseProduct }) {
  const t = useTranslations('CreatorStoreLicense');
  if (!env.enableLicenseNftUi || product.productKind !== 'license' || !product.license) return null;
  const { license } = product;
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left text-sm text-slate-800">
      <span className="inline-flex rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-900">
        {t('badge')}
      </span>
      <p className="mt-2">{license.remaining == null ? t('remainingUnknown') : t('remaining', { remaining: license.remaining, supply: license.supply })} · {t(license.transferable ? 'transferable' : 'nonTransferable')}</p>
      {product.sellerRole ? <p className="mt-1">{product.sellerRole === 'operator' ? t('sellerOperator') : product.sellerName ? t('sellerThirdParty', { name: product.sellerName }) : t('providerThirdParty')}</p> : null}
      <a href={license.termsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-indigo-800 underline underline-offset-2">
        {t('termsLink', { version: license.termsVersion })}
      </a>
      <p className="text-xs leading-relaxed text-slate-700">{t('deliveryNotice')}</p>
    </div>
  );
}
