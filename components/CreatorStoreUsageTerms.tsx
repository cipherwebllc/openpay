import { useTranslations } from 'next-intl';
import { USAGE_PERMISSION_KEYS, type StoreUsageTerms, type UsagePermissionKey } from '@/lib/store/usageTerms';

const ROW_LABEL_KEYS: Record<UsagePermissionKey, 'usageCommercial' | 'usageModify' | 'usageRedistribute'> = {
  commercial: 'usageCommercial',
  modify: 'usageModify',
  redistribute: 'usageRedistribute',
};

// 出品者が選んだ利用条件。選ばなかった項目も「記載なし」として 3 行とも出す (未記載 = Terms 第 13 条 (6) の既定)。
// variant='section' は購入モーダルの節 (仕様表と同じ型)・'summary' は署名直前の確認画面の「利用許諾」の行の中身。
// placement は 'section' の置き場所: 'modal' = 中央寄せ・見出し h3 (商品名 h2 の下)、
// 'page' = 商品ページ (?product=) の左寄せの節・見出し h2 (商品名 h1 の下)。
export function CreatorStoreUsageTerms({ usage, variant = 'section', placement = 'modal' }: { usage?: StoreUsageTerms; variant?: 'section' | 'summary'; placement?: 'modal' | 'page' }) {
  const t = useTranslations('CreatorStorePurchase');
  if (!usage) return null;
  const valueOf = (key: UsagePermissionKey) => {
    const value = usage[key];
    if (value === 'allowed') return <span className="font-bold text-emerald-700">{t('usageAllowed')}</span>;
    if (value === 'not_allowed') return <span className="font-bold text-slate-700">{t('usageNotAllowed')}</span>;
    return <span className="text-slate-500">{t('usageNotStated')}</span>;
  };
  const disclaimer = <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('usageDisclaimer')}</p>;

  if (variant === 'summary') {
    return (
      <>
        <ul className="space-y-1">
          {USAGE_PERMISSION_KEYS.map((key) => (
            <li key={key} className="flex flex-wrap gap-x-2">
              {/* 区切りを見える文字で出す (読み上げで「商用利用可」と続けて読まれないように)。 */}
              <span>{t(ROW_LABEL_KEYS[key])}:</span>
              {valueOf(key)}
            </li>
          ))}
        </ul>
        {usage.note ? <p className="mt-2 break-words">{t('usageNote')}: {usage.note}</p> : null}
        {disclaimer}
      </>
    );
  }

  const Heading = placement === 'page' ? 'h2' : 'h3';
  return (
    <section className={placement === 'page' ? 'max-w-prose' : 'mx-auto mt-5 max-w-prose text-left'}>
      <Heading className={`${placement === 'page' ? 'text-base' : 'text-sm'} font-bold text-slate-900`}>{t('usageHeading')}</Heading>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] text-sm">
        {USAGE_PERMISSION_KEYS.map((key) => (
          <div key={key} className="contents">
            <dt className="break-words border-b border-slate-200 py-2 pr-3 font-medium text-slate-700">{t(ROW_LABEL_KEYS[key])}</dt>
            <dd className="border-b border-slate-200 py-2">{valueOf(key)}</dd>
          </div>
        ))}
        {usage.note ? (
          <div className="contents">
            <dt className="break-words border-b border-slate-200 py-2 pr-3 font-medium text-slate-700">{t('usageNote')}</dt>
            <dd className="break-words border-b border-slate-200 py-2 text-slate-600">{usage.note}</dd>
          </div>
        ) : null}
      </dl>
      {disclaimer}
    </section>
  );
}
