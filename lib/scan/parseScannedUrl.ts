// QR scanner で読み取った text を「実行可能な ScanAction」へ正規化する。
// URL の安全性 + route 一致判定の SoT。
//
//   - 同 origin /pay /tip /checkout は既存 parser (lib/url.ts) に通し、params が
//     valid なときだけ pay/tip/checkout を返す。「URL 形は正しいが to/amount が
//     壊れている」状態は unknown に落として「後段で赤エラー」UX を排除。
//   - ethereum: (EIP-681) は Phase 1 では reject (Phase 2 で in-wallet 遷移検討)。
//   - 外部 origin の http(s) は external — UI 側に二段確認させる。
//   - それ以外 (URL でない / 同 origin だが route 未知) は unknown で raw 提示。

import { isAddress } from 'viem';
import { isLocale, type Locale } from '@/i18n';
import {
  parseCheckoutParams,
  parsePayParams,
  parseTipParams,
  type CheckoutParams,
  type PayParams,
  type TipParams,
} from '@/lib/url';

export type ScanAction =
  | { kind: 'pay'; href: string; params: PayParams }
  | { kind: 'tip'; href: string; params: TipParams }
  | { kind: 'checkout'; href: string; params: CheckoutParams }
  | { kind: 'external'; href: string; host: string }
  | { kind: 'eip681'; raw: string }
  | { kind: 'unknown'; raw: string };

type DecomposedPath =
  | { route: 'pay' | 'checkout' }
  | { route: 'tip'; tipAddress: string };

// /(ja|en)?/(pay|checkout|tip/0x...) のみ受理。trailing slash 許容。
// 部分一致は禁止 (URL の末端まで route 文字列と一致しなければ null)。
function decomposePath(pathname: string): DecomposedPath | null {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  const segments = trimmed.slice(1).split('/');

  // 先頭が locale なら 1 segment 進める (path 上の locale は捨て、出力 href は
  // 呼出側 currentLocale で組み直す確定形)。
  const start = isLocale(segments[0]) ? 1 : 0;
  const head = segments[start];
  const rest = segments.length - start;

  if ((head === 'pay' || head === 'checkout') && rest === 1) {
    return { route: head };
  }
  if (head === 'tip' && rest === 2 && isAddress(segments[start + 1]!)) {
    return { route: 'tip', tipAddress: segments[start + 1]! };
  }
  return null;
}

// 既存 lib/url.ts の builder と同形の path を出力。currentLocale を強制で頭に
// 付けることで、route 後の URL は middleware redirect を経由しない確定形になる。
function buildHref(
  route: 'pay' | 'tip' | 'checkout',
  currentLocale: Locale,
  tail: string,
  search: string,
): string {
  const tailPart = tail.length > 0 ? `/${tail}` : '';
  return `/${currentLocale}/${route}${tailPart}${search}`;
}

export function parseScannedUrl(
  text: string,
  origin: string,
  currentLocale: Locale,
): ScanAction {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'unknown', raw: text };

  // ethereum: (EIP-681) は Phase 1 では明示 reject。
  if (/^ethereum:/i.test(trimmed)) return { kind: 'eip681', raw: trimmed };

  if (!URL.canParse(trimmed)) return { kind: 'unknown', raw: text };
  const url = new URL(trimmed);

  // http(s) 以外 (file:, javascript:, data:, custom: 等) は同 origin 判定の
  // 対象外。EIP-681 以外の非 http(s) は unknown 扱いで XSS 経路を絶つ。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'unknown', raw: text };
  }

  if (url.origin !== origin) {
    return { kind: 'external', href: url.toString(), host: url.host };
  }

  const decomposed = decomposePath(url.pathname);
  if (!decomposed) return { kind: 'unknown', raw: text };

  // URLSearchParams は SearchParamsLike (.get(name)) を構造的に満たす。
  const sp = url.searchParams;

  switch (decomposed.route) {
    case 'pay': {
      const r = parsePayParams(sp);
      if (!r.ok) return { kind: 'unknown', raw: text };
      return {
        kind: 'pay',
        href: buildHref('pay', currentLocale, '', url.search),
        params: r.params,
      };
    }
    case 'checkout': {
      const r = parseCheckoutParams(sp);
      if (!r.ok) return { kind: 'unknown', raw: text };
      return {
        kind: 'checkout',
        href: buildHref('checkout', currentLocale, '', url.search),
        params: r.params,
      };
    }
    case 'tip': {
      // address は decomposePath で isAddress 通過済。parseTipParams で
      // checksum 化 + token/chain 妥当性を担保する。
      const r = parseTipParams(decomposed.tipAddress, sp);
      if (!r.ok) return { kind: 'unknown', raw: text };
      return {
        kind: 'tip',
        href: buildHref('tip', currentLocale, r.params.to, url.search),
        params: r.params,
      };
    }
  }
}
