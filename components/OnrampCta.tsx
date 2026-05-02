'use client';

import { useLocale, useTranslations } from 'next-intl';
import { isLocale, DEFAULT_LOCALE } from '@/i18n';
import { getExchangeLink } from '@/lib/links';
import type { TokenSymbol } from '@/lib/tokens';

// 残高不足時に挿入される取引所購入導線。3 つの form (Payment / Tip / Checkout) で
// 同形のため共通化。namespace 引数は呼出側 form の i18n namespace を受け取り、
// onrampCta / onrampJaResidentsOnlyNote / onrampJapaneseUserHint の 3 キーを参照する。
export function OnrampCta({
  token,
  namespace,
}: {
  token: TokenSymbol;
  namespace: 'PaymentForm' | 'TipForm' | 'CheckoutForm';
}) {
  const localeRaw = useLocale();
  // LocaleLayout で notFound() に倒される前提だが、型を絞るため guard を通す。
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const t = useTranslations(namespace);
  const link = getExchangeLink(token, locale);
  const displaySymbol = token.toUpperCase();

  return (
    <span className="mt-1 block">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-red-700 underline hover:text-red-800"
      >
        {t('onrampCta', { label: link.label, token: displaySymbol })}
      </a>
      {link.jaResidentsOnly && (
        <span className="ml-1 text-red-600">
          {t('onrampJaResidentsOnlyNote')}
        </span>
      )}
      {link.blocksJapaneseResidents && (
        <span className="mt-0.5 block text-red-600">
          {t('onrampJapaneseUserHint')}
        </span>
      )}
    </span>
  );
}
