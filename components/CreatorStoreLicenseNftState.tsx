import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import { licenseMintTxUrl, licenseNftState, type StoreLicenseProof } from '@/lib/licenseUi';

export function CreatorStoreLicenseNftState({ nft, entitled, basis, chainId, received = false }: {
  nft?: StoreLicenseProof;
  entitled?: boolean | null;
  basis?: 'purchase' | 'holder' | null;
  chainId?: number;
  received?: boolean;
}) {
  const t = useTranslations('CreatorStoreLicense');
  if (!env.enableLicenseNftUi) return null;
  const state = licenseNftState(nft, entitled, basis);
  // 購入時のチェーンが不明な場合は、別チェーンの tx リンクを作らない。
  const txUrl = state === 'minted'
    ? licenseMintTxUrl(nft?.mintTxHash, chainId)
    : null;
  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      <p className="font-bold">{t('nftState', { state: t(`states.${state}`) })}</p>
      {txUrl ? <a href={txUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">{t('mintTransaction')}</a> : null}
      <p className="mt-1 text-xs leading-relaxed">{t(received ? 'holderRights' : state === 'transferred' ? 'transferredRights' : 'purchaseRights')}</p>
    </div>
  );
}
