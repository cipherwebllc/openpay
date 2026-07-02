// QR scanner で読み取った text を「実行可能な ScanAction」へ正規化する。
// URL の安全性 + route 一致判定の SoT。
//
//   - 同 origin /pay /tip /checkout は既存 parser (lib/url.ts) に通し、params が
//     valid なときだけ pay/tip/checkout を返す。「URL 形は正しいが to/amount が
//     壊れている」状態は unknown に落として「後段で赤エラー」UX を排除。
//   - 同 origin /@handle (固定店舗 / プロフ) は形式・予約語が valid かつ enableHandles の
//     ときだけ handle。存在確認はしない (= 純関数を維持)。未登録 handle は遷移先 [handle]
//     ページが notFound を出す。enableHandles OFF のときは unknown (404 への遷移を防ぐ)。
//   - 同 origin /order?s=… (モバイル注文) は decodeOrderConfig が通り enableMobileOrder の
//     ときだけ order。s トークンは attacker-controllable ゆえ厳格 decode が必須 (遷移先も再検証)。
//   - ethereum: (EIP-681) は Phase 1 では reject (Phase 2 で in-wallet 遷移検討)。
//   - 外部 origin の http(s) は external — UI 側に二段確認させる。
//   - それ以外 (URL でない / 同 origin だが route 未知) は unknown で raw 提示。

import { isAddress } from 'viem';
import { isLocale, type Locale } from '@/i18n';
import {
  offOriginCallbackHosts,
  parseCheckoutParams,
  parsePayParams,
  parseTipParams,
  type CheckoutParams,
  type PayParams,
  type TipParams,
} from '@/lib/url';
import {
  decodeHandleSegment,
  normalizeHandle,
  isValidHandleFormat,
  isReserved,
} from '@/lib/handle';
import { decodeOrderConfig } from '@/lib/mobileOrder';

export type ScanAction =
  | { kind: 'pay'; href: string; params: PayParams }
  // offOriginHosts: webhook/thanksUrl (tip) / webhook/success_url/cancel_url (checkout) のうち
  // origin と host が異なる第三者ホスト一覧。空でなければ ScanShell は自動遷移せず amber
  // interstitial + 明示 continue を挟む (外部 URL と同じ二段確認)。
  | { kind: 'tip'; href: string; params: TipParams; offOriginHosts: string[] }
  | {
      kind: 'checkout';
      href: string;
      params: CheckoutParams;
      offOriginHosts: string[];
    }
  | { kind: 'handle'; href: string; handle: string }
  | { kind: 'order'; href: string }
  | { kind: 'external'; href: string; host: string }
  | { kind: 'eip681'; raw: string }
  | { kind: 'unknown'; raw: string };

// route 種別ごとの追加情報を持つフラグ判定の入力。flag は呼出側 (ScanShell) が env から渡す
// (parseScannedUrl の純粋性・テスト容易性を保つため env を直接読まない)。未指定は fail-closed。
export type ScanOptions = {
  enableHandles?: boolean;
  enableMobileOrder?: boolean;
};

type DecomposedPath =
  | { route: 'pay' | 'checkout' }
  | { route: 'tip'; tipAddress: string }
  | { route: 'handle'; handle: string }
  | { route: 'order' };

// /(ja|en)?/(pay|checkout|order|@handle|tip/0x...) のみ受理。trailing slash 許容。
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
  // /order?s=… (モバイル注文)。s トークンの検証は呼出側 (decodeOrderConfig)。
  if (head === 'order' && rest === 1) {
    return { route: 'order' };
  }
  if (head === 'tip' && rest === 2 && isAddress(segments[start + 1]!)) {
    return { route: 'tip', tipAddress: segments[start + 1]! };
  }
  // /@handle (固定店舗 / プロフ)。生 `@` も `%40` も受ける (Next は dynamic param を
  // 自動デコードしない)。単一 segment のみ。decode→正規化→形式/予約語を満たすときだけ
  // handle。`@` 始まりだが形式/予約語 NG は null (= unknown)。
  if (rest === 1 && head !== undefined) {
    const decoded = decodeHandleSegment(head);
    if (decoded.startsWith('@')) {
      const handle = normalizeHandle(decoded);
      if (isValidHandleFormat(handle) && !isReserved(handle)) {
        return { route: 'handle', handle };
      }
      return null;
    }
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
  opts: ScanOptions = {},
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
        // 同 origin checkout でも callback (webhook/success/cancel) が第三者ホストなら
        // 自動遷移させず interstitial へ (ScanShell が offOriginHosts で分岐)。
        offOriginHosts: offOriginCallbackHosts(
          [r.params.webhook, r.params.successUrl, r.params.cancelUrl],
          url.host,
        ),
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
        // 同 origin tip でも callback (webhook/thanksUrl) が第三者ホストなら interstitial へ。
        offOriginHosts: offOriginCallbackHosts(
          [r.params.webhook, r.params.thanksUrl],
          url.host,
        ),
      };
    }
    case 'handle': {
      // 形式/予約語は decomposePath で検証済。flag OFF (本番未点灯) は unknown=404 回避。
      if (!opts.enableHandles) return { kind: 'unknown', raw: text };
      return {
        kind: 'handle',
        href: `/${currentLocale}/@${decomposed.handle}`,
        handle: decomposed.handle,
      };
    }
    case 'order': {
      if (!opts.enableMobileOrder) return { kind: 'unknown', raw: text };
      // s トークンは untrusted。decodeOrderConfig が通る (= 全項目 valid) ときだけ order。
      const s = sp.get('s');
      if (!s || decodeOrderConfig(s) === null) return { kind: 'unknown', raw: text };
      return { kind: 'order', href: `/${currentLocale}/order${url.search}` };
    }
  }
}
