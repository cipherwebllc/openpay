// QR scanner で読み取った text を「実行可能な ScanAction」へ正規化する。
//
// 目的: scanner UI は decode できれば良いだけ、URL の安全性 / 既知 route との
// 一致判定は本モジュールが SoT になる。
//
// 設計:
//   - 同一 origin の /pay /tip /checkout は既存 parser (lib/url.ts) に通して
//     params が valid なときだけ kind: 'pay' | 'tip' | 'checkout' を返す。
//     これにより「URL 形は正しいが to/amount/items が壊れている」状態を
//     unknown へ落として PaymentForm 側の赤エラーを scanner で先に検知する。
//   - ethereum: (EIP-681) は Phase 1 では reject (kind: 'eip681') — Phase 2 で
//     in-wallet 直接遷移 UX を検討。
//   - 外部 origin の http(s) URL は kind: 'external' で UI 側に二段確認させる。
//   - 上記いずれにも該当しない (URL でない / 内部 path だが route 未知) は
//     kind: 'unknown' で文字列をそのまま提示。
//
// LARP 防御: parse 結果に応じた「partial 処理」は一切しない。/pay の to=… が
// 不正なら unknown に落とす (= 部分情報で先に進めて後段でエラーにする UX を排除)。

import { isAddress, type Address } from 'viem';
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
  | {
      kind: 'tip';
      href: string;
      params: TipParams;
      address: Address;
    }
  | { kind: 'checkout'; href: string; params: CheckoutParams }
  | { kind: 'external'; href: string; host: string }
  | { kind: 'eip681'; raw: string }
  | { kind: 'unknown'; raw: string };

type RouteKind = 'pay' | 'tip' | 'checkout';

type DecomposedPath = {
  // URL に lined-up していた locale prefix (あれば、なければ null)。
  // 出力 href の locale は呼出側の currentLocale を優先するため捨てて構わないが、
  // 別 locale の URL が読まれたケース判定や test の見やすさのため保持。
  pathLocale: Locale | null;
  route: RouteKind;
  // tip のときだけ tail として address (checksum 前) を保持。それ以外は null。
  tipAddress: string | null;
};

// /(ja|en)?/(pay|tip/0x.../checkout) のみ受理。trailing slash 許容。
// 部分一致は禁止 (URL の末端まで route 文字列と一致しなければ null)。
function decomposePath(pathname: string): DecomposedPath | null {
  // 先頭 '/' を 1 回剥がして segment 配列へ。空 path は受理しない。
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  const segments = trimmed.slice(1).split('/');

  let pathLocale: Locale | null = null;
  let cursor = 0;
  if (segments[cursor] && isLocale(segments[cursor]!)) {
    pathLocale = segments[cursor] as Locale;
    cursor += 1;
  }

  const head = segments[cursor];
  if (!head) return null;

  if (head === 'pay') {
    // /pay の後に segment があれば未知 path (例: /pay/foo) なので reject。
    if (cursor + 1 !== segments.length) return null;
    return { pathLocale, route: 'pay', tipAddress: null };
  }

  if (head === 'checkout') {
    if (cursor + 1 !== segments.length) return null;
    return { pathLocale, route: 'checkout', tipAddress: null };
  }

  if (head === 'tip') {
    // /tip は必ず address tail を要求 (/tip 単体は parseTipParams 側でも fail)。
    const addr = segments[cursor + 1];
    if (!addr) return null;
    if (cursor + 2 !== segments.length) return null;
    if (!isAddress(addr)) return null;
    return { pathLocale, route: 'tip', tipAddress: addr };
  }

  return null;
}

// SearchParams-like wrapper — lib/url.ts の SearchParamsLike を満たす。
function paramsFromUrl(url: URL) {
  return {
    get(name: string): string | null {
      return url.searchParams.get(name);
    },
  };
}

// 既存 lib/url.ts の builder と同形の path を出力。currentLocale を強制で頭に
// 付けることで、route 後の URL は middleware redirect を経由しない確定形になる。
function buildHref(
  route: RouteKind,
  currentLocale: Locale,
  tail: string,
  search: string,
): string {
  const tailPart = tail.length > 0 ? `/${tail}` : '';
  // URL.search は '?...' 形式 (空文字なら '')。?を含めて concat するため
  // 既に '?' を持っていることを assume。
  return `/${currentLocale}/${route}${tailPart}${search}`;
}

export function parseScannedUrl(
  text: string,
  origin: string,
  currentLocale: Locale,
): ScanAction {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'unknown', raw: text };

  // ethereum: (EIP-681) は Phase 1 では明示 reject。raw を返して UI で
  // 「対応 wallet で直接お試しください」誘導に使う。
  if (/^ethereum:/i.test(trimmed)) {
    return { kind: 'eip681', raw: trimmed };
  }

  // URL.canParse は invalid URL に対しても throw しない (true/false のみ)。
  // 相対 URL は base なしで false。
  if (!URL.canParse(trimmed)) {
    return { kind: 'unknown', raw: text };
  }
  const url = new URL(trimmed);

  // http(s) 以外 (file:, javascript:, data:, custom: 等) は同 origin 判定の
  // 対象外。EIP-681 以外の非 http(s) は unknown 扱いで UI に raw 提示。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'unknown', raw: text };
  }

  // origin 比較は URL.origin で大文字小文字 / port / trailing slash を一意化。
  if (url.origin !== origin) {
    return { kind: 'external', href: url.toString(), host: url.host };
  }

  const decomposed = decomposePath(url.pathname);
  if (!decomposed) return { kind: 'unknown', raw: text };

  const sp = paramsFromUrl(url);

  if (decomposed.route === 'pay') {
    const r = parsePayParams(sp);
    if (!r.ok) return { kind: 'unknown', raw: text };
    return {
      kind: 'pay',
      href: buildHref('pay', currentLocale, '', url.search),
      params: r.params,
    };
  }

  if (decomposed.route === 'checkout') {
    const r = parseCheckoutParams(sp);
    if (!r.ok) return { kind: 'unknown', raw: text };
    return {
      kind: 'checkout',
      href: buildHref('checkout', currentLocale, '', url.search),
      params: r.params,
    };
  }

  // tip: address は decomposePath で isAddress 通過済。parseTipParams にもう
  // 一度通して checksum 化 + token/chain 妥当性を担保する。
  const tipAddrRaw = decomposed.tipAddress!;
  const r = parseTipParams(tipAddrRaw, sp);
  if (!r.ok) return { kind: 'unknown', raw: text };
  return {
    kind: 'tip',
    href: buildHref('tip', currentLocale, r.params.to, url.search),
    params: r.params,
    address: r.params.to,
  };
}
