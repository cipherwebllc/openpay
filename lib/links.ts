// 取引所リンク (onramp / offramp 共通)。
//   - 顧客 (残高不足時): その取引所で token を購入してから戻る導線。
//   - 店主 (受取後)    : その取引所で受け取った token を JPY (または USD) に換金する導線。
// onramp と offramp で URL は同一なので purpose 引数は持たない。文脈別の文言は
// i18n で出し分ける (PaymentForm.onrampCta / Home.offrampHeading 等)。
//
// locale 軸:
//   ja → 日本居住者向け取引所 (JPYC EX, SBI VC トレード)
//   en → 国際向け取引所 (Coinbase)。Japanese resident は登録不可なので
//        UI で "switch to Japanese for SBI VC Trade" のヒントを出す。
import type { Locale } from '@/i18n';
import type { TokenSymbol } from './tokens';

export type ExchangeLink = {
  url: string;
  label: string;
  // True for exchanges that only accept Japan residents (JPYC EX).
  // UI may show "Japan residents only" inline note when locale=en.
  jaResidentsOnly?: boolean;
  // True for exchanges that block Japan residents (Coinbase post-2023 Japan exit).
  // UI may suggest switching to ja locale to surface SBI VC Trade.
  blocksJapaneseResidents?: boolean;
};

const EXCHANGE_LINKS = {
  jpyc: {
    ja: {
      url: 'https://jpyc.co.jp/',
      label: 'JPYC 公式',
    },
    en: {
      url: 'https://jpyc.co.jp/',
      label: 'JPYC official',
      jaResidentsOnly: true,
    },
  },
  usdc: {
    ja: {
      url: 'https://www.sbivc.co.jp/',
      label: 'SBI VC トレード',
    },
    en: {
      url: 'https://www.coinbase.com/',
      label: 'Coinbase',
      blocksJapaneseResidents: true,
    },
  },
} as const satisfies Record<TokenSymbol, Record<Locale, ExchangeLink>>;

export function getExchangeLink(
  token: TokenSymbol,
  locale: Locale,
): ExchangeLink {
  return EXCHANGE_LINKS[token][locale];
}
