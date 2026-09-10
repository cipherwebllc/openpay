import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import type { StoreLicenseProduct } from '@/lib/licenseUi';

// サーバーが在庫から計算した残数のみを使う。取得失敗を在庫ありに見せない。
// variant='card' は一覧カード用 (バッジ + 残数のみ・2026-09-10 user 裁定: 販売者区分・利用条件・
// 発行時期の開示は購入確認画面と詳細モーダル ('full') が担うので、カードのデザインを崩さない)。
export function CreatorStoreLicenseDetails({ product, variant = 'full' }: { product: StoreLicenseProduct; variant?: 'full' | 'card' }) {
  const t = useTranslations('CreatorStoreLicense');
  if (!env.enableLicenseNftUi || product.productKind !== 'license' || !product.license) return null;
  const { license } = product;
  const remaining = license.remaining == null ? t('remainingUnknown') : t('remaining', { remaining: license.remaining, supply: license.supply });
  if (variant === 'card') {
    // テーマ地色 (プロフの inverted 配色) に依存しないよう、どちらもチップにする。
    return (
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-left">
        <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-900">{t('badge')}</span>
        <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">{remaining}</span>
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left text-sm text-slate-800">
      <span className="inline-flex rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-900">
        {t('badge')}
      </span>
      <p className="mt-2">{remaining} · {t(license.transferable ? 'transferable' : 'nonTransferable')}</p>
      {product.sellerRole ? <p className="mt-1">{product.sellerRole === 'operator' ? t('sellerOperator') : product.sellerName ? t('sellerThirdParty', { name: product.sellerName }) : t('providerThirdParty')}</p> : null}
      <a href={license.termsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-indigo-800 underline underline-offset-2">
        {t('termsLink', { version: license.termsVersion })}
      </a>
      <p className="text-xs leading-relaxed text-slate-700">{t('deliveryNotice')}</p>
    </div>
  );
}
