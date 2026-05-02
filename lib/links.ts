// 取引所リンク (onramp / offramp 共通)。en では JPYC は Japan residents only、
// USDC は Coinbase (2023 日本撤退) のため、locale 軸で出し分ける。
// URL 生存確認 2026-05-02: jpyc.co.jp / sbivc.co.jp = 200、coinbase.com は
// bot 保護で CLI 不可・実 browser 可。月次目視推奨。
import type { Locale } from '@/i18n';
import type { TokenSymbol } from './tokens';

export type ExchangeLink = {
  url: string;
  label: string;
  // JPYC EX 等の日本居住者限定取引所
  jaResidentsOnly?: boolean;
  // Coinbase 等 (2023 日本撤退) のように日本居住者の登録を拒否する取引所
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
