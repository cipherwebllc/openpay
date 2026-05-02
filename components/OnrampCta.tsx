'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { getExchangeLink } from '@/lib/links';
import type { TokenSymbol } from '@/lib/tokens';

// 残高不足時に挿入される取引所購入導線。3 form (Payment / Tip / Checkout) 共通。
// namespace 引数は呼出側の i18n namespace を渡し、onrampCta /
// onrampJaResidentsOnlyNote / onrampJapaneseUserHint の 3 キーを参照する。
export function OnrampCta({
  token,
  namespace,
}: {
  token: TokenSymbol;
  namespace: 'PaymentForm' | 'TipForm' | 'CheckoutForm';
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations(namespace);
  const link = getExchangeLink(token, locale);

  return (
    <span className="mt-1 block">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-red-700 underline hover:text-red-800"
      >
        {t('onrampCta', { label: link.label, token: token.toUpperCase() })}
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
